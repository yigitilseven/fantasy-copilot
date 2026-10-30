import { describe, expect, it } from "vitest";
import { decideRun, inQuietHours, isLocalWeekday, jitteredDelayMs, localDay, nextDailyAt, parseHHMM, runsOnLocalDay, type RunDecisionInput } from "@/ops/timing";

describe("nextDailyAt", () => {
  it("finds the next local 08:30 (winter, UTC-5 New York)", () => {
    const now = Date.parse("2026-01-15T10:00:00Z"); // 05:00 local
    expect(new Date(nextDailyAt(now, "08:30", "America/New_York")).toISOString()).toBe("2026-01-15T13:30:00.000Z");
  });
  it("rolls to tomorrow when the time has passed, and across DST", () => {
    const after = Date.parse("2026-03-07T14:00:00Z"); // 09:00 EST, Sat
    expect(new Date(nextDailyAt(after, "08:30", "America/New_York")).toISOString()).toBe("2026-03-08T12:30:00.000Z"); // DST starts 03-08: 08:30 is EDT (UTC-4)
  });
  it("is strictly after now", () => {
    const t = Date.parse("2026-06-01T12:30:00Z"); // exactly 08:30 EDT
    expect(nextDailyAt(t, "08:30", "America/New_York")).toBe(t + 86_400_000);
  });
  it("works for UTC and Europe/Istanbul", () => {
    expect(new Date(nextDailyAt(Date.parse("2026-10-27T00:00:00Z"), "08:30", "UTC")).toISOString()).toBe("2026-10-27T08:30:00.000Z");
    expect(new Date(nextDailyAt(Date.parse("2026-10-27T00:00:00Z"), "08:30", "Europe/Istanbul")).toISOString()).toBe("2026-10-27T05:30:00.000Z");
    expect(() => nextDailyAt(0, "25:00", "UTC")).toThrow();
    expect(parseHHMM("7:05")).toEqual({ h: 7, m: 5 });
  });
});

describe("jitter", () => {
  it("stays within base +/- jitter and above one minute", () => {
    expect(jitteredDelayMs(7_200_000, 1_200_000, () => 0)).toBe(6_000_000);
    expect(jitteredDelayMs(7_200_000, 1_200_000, () => 1)).toBe(8_400_000);
    expect(jitteredDelayMs(7_200_000, 1_200_000, () => 0.5)).toBe(7_200_000);
    for (let i = 0; i < 200; i++) {
      const v = jitteredDelayMs(7_200_000, 1_200_000);
      expect(v).toBeGreaterThanOrEqual(6_000_000);
      expect(v).toBeLessThanOrEqual(8_400_000);
    }
    expect(jitteredDelayMs(1000, 0)).toBe(60_000);
  });
});

describe("quiet hours and caps", () => {
  const tz = "America/New_York";
  it("handles ranges that wrap midnight", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(inQuietHours(at("2026-01-15T06:30:00Z"), tz, "01:00-06:00")).toBe(true); // 01:30 local
    expect(inQuietHours(at("2026-01-15T12:00:00Z"), tz, "01:00-06:00")).toBe(false); // 07:00 local
    expect(inQuietHours(at("2026-01-15T04:30:00Z"), tz, "23:00-06:00")).toBe(true); // 23:30 local
    expect(inQuietHours(at("2026-01-15T04:30:00Z"), tz, "")).toBe(false);
  });
  const base: RunDecisionInput = { now: Date.parse("2026-01-15T17:00:00Z"), tz, history: [], maxPerDay: 14, manual: false, needsLogin: false, loginRetryMs: 6 * 3_600_000, minGapMs: 20 * 60_000 };
  it("caps runs per local day", () => {
    const history = Array.from({ length: 14 }, (_, i) => base.now - (i + 1) * 30 * 60_000);
    expect(runsOnLocalDay(history, base.now, tz)).toBe(14);
    expect(decideRun({ ...base, history })).toEqual({ run: false, reason: "cap" });
    expect(decideRun({ ...base, history, manual: true })).toEqual({ run: false, reason: "cap" });
    expect(decideRun({ ...base, history: history.slice(1) })).toEqual({ run: true });
    expect(localDay(Date.parse("2026-01-15T03:00:00Z"), tz)).toBe("2026-01-14");
  });
  it("applies quiet hours and the login back-off to scheduled runs only", () => {
    const night = { ...base, now: Date.parse("2026-01-15T07:00:00Z"), quietHours: "01:00-06:00" }; // 02:00 local
    expect(decideRun(night).reason).toBe("quiet");
    expect(decideRun({ ...night, manual: true }).run).toBe(true);
    const down = { ...base, needsLogin: true, lastRunAt: base.now - 3_600_000 };
    expect(decideRun(down).reason).toBe("needs-login");
    expect(decideRun({ ...down, lastRunAt: base.now - 7 * 3_600_000 }).run).toBe(true);
    expect(decideRun({ ...down, manual: true }).run).toBe(true);
  });
  it("enforces the minimum gap", () => {
    expect(decideRun({ ...base, lastRunAt: base.now - 60_000 }).reason).toBe("too-soon");
  });
});

describe("isLocalWeekday", () => {
  // 2026-10-26 is a Monday; 22:30 UTC Sunday 25th is already Monday 01:30 in Istanbul
  it("uses the local calendar day", () => {
    expect(isLocalWeekday(Date.parse("2026-10-26T09:00:00Z"), "Europe/Istanbul", "Mon")).toBe(true);
    expect(isLocalWeekday(Date.parse("2026-10-25T22:30:00Z"), "Europe/Istanbul", "monday")).toBe(true);
    expect(isLocalWeekday(Date.parse("2026-10-25T22:30:00Z"), "UTC", "Mon")).toBe(false);
  });
  it("empty or unknown day = never", () => {
    expect(isLocalWeekday(Date.parse("2026-10-26T09:00:00Z"), "UTC", "")).toBe(false);
    expect(isLocalWeekday(Date.parse("2026-10-26T09:00:00Z"), "UTC", undefined)).toBe(false);
    expect(isLocalWeekday(Date.parse("2026-10-26T09:00:00Z"), "UTC", "xyz")).toBe(false);
  });
});
