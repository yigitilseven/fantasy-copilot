import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, dateRange, daysBetween, fantasyWeekNumber, gameDayOf, gamesInRange, hasGame, parseScheduleJson, weekEndOf, weekStartOf, weeksRemaining } from "@/engine/season/schedule";
import { loadSchedule, refreshSchedule, resetScheduleCaches, scheduleStatus, storeSchedule } from "@/integrations/schedule/nba-schedule";
import { TEAMS, makeScheduleJson } from "./season-fixtures";

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures-season", "schedule-mini.json"), "utf8"));

describe("parseScheduleJson (scheduleLeagueV2.json shape)", () => {
  it("keeps regular-season games only, canonicalizes teams, one date per team and game day", () => {
    const s = parseScheduleJson(fixture());
    expect(s.season).toBe("2026-27");
    expect(s.games).toBe(5); // preseason, playoff and the label-only play-in rows are skipped
    expect(s.teams.LAL).toEqual(["2026-10-20", "2026-10-22"]);
    expect(s.teams.BOS).toEqual(["2026-10-20", "2026-10-24"]);
    expect(s.teams.GSW).toContain("2026-10-21"); // "GS" -> GSW
    expect(s.teams.NYK).toBeDefined(); // "NY" -> NYK
    expect(s.firstDate).toBe("2026-10-20");
    expect(s.lastDate).toBe("2026-10-24");
  });
  it("accepts the MM/DD/YYYY gameDate when gameDateEst is missing and throws on an HTML block page", () => {
    const j = { leagueSchedule: { seasonYear: "2026-27", gameDates: [{ gameDate: "11/03/2026 00:00:00", games: [{ gameId: "0022600100", homeTeam: { teamTricode: "MIA" }, awayTeam: { teamTricode: "ORL" } }] }] } };
    expect(parseScheduleJson(j).teams.MIA).toEqual(["2026-11-03"]);
    expect(() => parseScheduleJson({})).toThrow(/gameDates/);
  });
  it("a generated full season has ~3.5 games per team per week", () => {
    const s = parseScheduleJson(makeScheduleJson());
    const avg = Object.values(s.teams).reduce((a, d) => a + d.length, 0) / TEAMS.length;
    const weeks = daysBetween("2026-10-20", "2027-04-11") / 7;
    expect(avg / weeks).toBeGreaterThan(3.1);
    expect(avg / weeks).toBeLessThan(3.9);
  });
});

describe("fantasy weeks (Mon-Sun)", () => {
  it("week boundaries, ranges and numbering", () => {
    expect(weekStartOf("2026-10-20")).toBe("2026-10-19"); // Tuesday -> Monday
    expect(weekEndOf("2026-10-20")).toBe("2026-10-25");
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19"); // Sunday belongs to the week that started Monday
    expect(weekStartOf("2026-10-26")).toBe("2026-10-26");
    expect(dateRange("2026-10-24", "2026-10-26")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const s = parseScheduleJson(fixture());
    expect(fantasyWeekNumber(s, "2026-10-20")).toBe(1);
    expect(fantasyWeekNumber(s, "2026-10-26")).toBe(2);
    expect(fantasyWeekNumber(s, "2026-10-01")).toBeNull();
    expect(fantasyWeekNumber(null, "2026-10-20")).toBeNull();
    expect(weeksRemaining(s, "2026-10-20")).toBe(1);
  });
  it("game lookups", () => {
    const s = parseScheduleJson(fixture());
    expect(hasGame(s.teams, "LAL", "2026-10-22")).toBe(true);
    expect(hasGame(s.teams, "LAL", "2026-10-23")).toBe(false);
    expect(hasGame(null, "LAL", "2026-10-22")).toBe(false);
    expect(gamesInRange(s.teams, "BOS", "2026-10-20", "2026-10-25")).toBe(2);
    expect(gamesInRange(s.teams, "XXX", "2026-10-20", "2026-10-25")).toBe(0);
  });
  it("the game day rolls over at midnight in the configured zone (Pacific by default)", () => {
    expect(gameDayOf(Date.parse("2026-10-21T05:00:00Z"))).toBe("2026-10-20"); // 22:00 PDT on the 20th
    expect(gameDayOf(Date.parse("2026-10-21T08:00:00Z"))).toBe("2026-10-21");
    expect(gameDayOf(Date.parse("2026-10-21T05:00:00Z"), "Europe/Istanbul")).toBe("2026-10-21");
  });
});

describe("schedule cache", () => {
  let dir: string;
  beforeEach(() => {
    resetScheduleCaches();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  });
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const blocked = (async () => new Response("<HTML>Access Denied</HTML>", { status: 403 })) as unknown as typeof fetch;

  it("no cache: status says so; a failing fetch is reported and never throws (fallback = no schedule)", async () => {
    expect(loadSchedule(dir)).toBeNull();
    const st = await refreshSchedule(dir, { fetchImpl: blocked });
    expect(st.games).toBe(0);
    expect(st.error).toMatch(/HTTP 403/);
    expect(scheduleStatus(dir).stale).toBe(true);
  });
  it("fetch stores + parses; a fresh cache is not refetched; a stale one is; failure keeps the old file", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify(fixture()), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await refreshSchedule(dir, { fetchImpl: f });
    expect(a.games).toBe(5);
    expect(a.stale).toBe(false);
    expect(loadSchedule(dir)?.teams.LAL).toHaveLength(2);
    await refreshSchedule(dir, { fetchImpl: f });
    expect(calls).toBe(1);
    const old = new Date(Date.now() - 30 * 3_600_000);
    fs.utimesSync(path.join(dir, "nba-schedule.json"), old, old);
    const b = await refreshSchedule(dir, { fetchImpl: blocked });
    expect(b.games).toBe(5); // old cache kept
    expect(b.stale).toBe(true);
    expect(b.error).toMatch(/403/);
    await refreshSchedule(dir, { fetchImpl: f, force: true });
    expect(calls).toBe(2);
  });
  it("rejects a non-schedule body instead of caching it; storeSchedule validates", async () => {
    const st = await refreshSchedule(dir, { fetchImpl: ok({ hello: 1 }) });
    expect(st.games).toBe(0);
    expect(fs.existsSync(path.join(dir, "nba-schedule.json"))).toBe(false);
    expect(() => storeSchedule(dir, "<html>")).toThrow();
  });
});
