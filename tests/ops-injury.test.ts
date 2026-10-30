import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { getLeague, getRosters } from "@/db/season";
import type { StatusChange } from "@/integrations/news/update";
import { applyLimits, detectRosterChanges, formatInjuryAlert, formatInjuryEvent, recordSent, takeAllowed, type LimiterState } from "@/ops/injury-watch";
import { ackInjuryEvents, pendingInjuryEvents, recordInjuryEvents } from "@/server/injury-events";
import { seedSeasonLeague } from "./season-fixtures";

const ch = (playerId: string, before: StatusChange["before"]["status"], after: StatusChange["after"]["status"], extra: Partial<StatusChange["after"]> = {}): StatusChange => ({
  playerId, name: `P ${playerId}`, adp: 10, before: { status: before }, after: { status: after, ...extra },
});

describe("detectRosterChanges", () => {
  const roster = new Set(["a", "b"]);
  it("keeps only status changes of players on the roster", () => {
    const ev = detectRosterChanges(
      [ch("a", "healthy", "out", { injury: "ankle", estReturn: "2 weeks", source: "ESPN" }), ch("x", "healthy", "out"), ch("b", "out", "healthy"), ch("a", "day-to-day", "day-to-day", { estReturn: "tomorrow" })],
      roster,
      "2026-10-27T10:00:00Z",
    );
    expect(ev.map((e) => [e.playerId, e.before, e.after, e.direction])).toEqual([["a", "healthy", "out", "worse"], ["b", "out", "healthy", "better"]]);
    expect(formatInjuryEvent(ev[0])).toBe("- P a: healthy -> OUT (ankle; return 2 weeks; ESPN)");
    expect(formatInjuryEvent(ev[1])).toBe("+ P b: OUT -> healthy");
  });
  it("covers day-to-day and out-for-season", () => {
    const ev = detectRosterChanges([ch("a", "healthy", "day-to-day"), ch("b", "out", "out-for-season")], roster);
    expect(ev.map((e) => e.direction)).toEqual(["worse", "worse"]);
    expect(formatInjuryAlert(ev)).toMatchObject({ title: "2 status changes on your roster (2 worse)" });
    expect(formatInjuryAlert([ev[1]]).title).toBe("P b is now OUT FOR SEASON");
  });
});

describe("limits", () => {
  const empty = (): LimiterState => ({ seen: {}, sent: [], takes: [] });
  const [e1, e2] = detectRosterChanges([ch("a", "healthy", "out"), ch("b", "healthy", "out")], new Set(["a", "b"]));
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("suppresses the same player+status inside the cooldown", () => {
    const st = recordSent(empty(), [e1], now - 3_600_000, false);
    const r = applyLimits([e1, e2], st, now);
    expect(r.send.map((e) => e.playerId)).toEqual(["b"]);
    expect(r.suppressed.map((e) => e.playerId)).toEqual(["a"]);
    expect(applyLimits([e1], st, now + 7 * 3_600_000).send).toHaveLength(1);
  });
  it("caps alert messages per hour and Claude takes per day", () => {
    let st = empty();
    for (let i = 0; i < 6; i++) st = recordSent(st, [], now - i * 60_000, true);
    expect(applyLimits([e1], st, now).capped).toBe(true);
    expect(applyLimits([e1], st, now).send).toEqual([]);
    expect(takeAllowed(st, now)).toBe(false); // 6 takes today
    expect(takeAllowed(recordSent(empty(), [], now - 10 * 60_000, true), now)).toBe(false); // min gap
    expect(takeAllowed(recordSent(empty(), [], now - 30 * 60_000, true), now)).toBe(true);
  });
});

describe("event queue in the DB", () => {
  let db: Db;
  let mine: string, other: string;
  beforeEach(() => {
    db = createDb(":memory:");
    seedSeasonLeague(db);
    const lg = getLeague(db)!;
    const rosters = getRosters(db, lg.id);
    mine = rosters.get(lg.userSlot)![0].playerId;
    other = rosters.get(lg.userSlot === 1 ? 2 : 1)![0].playerId;
  });
  it("queues only my players, dedupes and acknowledges", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    const added = recordInjuryEvents(db, { statusChanges: [ch(mine, "healthy", "out"), ch(other, "healthy", "out")] }, now);
    expect(added.map((e) => e.playerId)).toEqual([mine]);
    expect(recordInjuryEvents(db, { statusChanges: [ch(mine, "healthy", "out")] }, now + 1000)).toEqual([]);
    expect(pendingInjuryEvents(db, now + 2000)).toHaveLength(1);
    expect(pendingInjuryEvents(db, now + 25 * 3_600_000)).toHaveLength(0); // stale events expire
    expect(ackInjuryEvents(db, [added[0].id])).toBe(1);
    expect(pendingInjuryEvents(db, now + 2000)).toHaveLength(0);
  });
  it("is a no-op without a league", () => {
    const empty = createDb(":memory:");
    expect(recordInjuryEvents(empty, { statusChanges: [ch("a", "healthy", "out")] })).toEqual([]);
    expect(pendingInjuryEvents(empty)).toEqual([]);
  });
});
