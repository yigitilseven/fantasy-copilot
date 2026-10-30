import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/season-db-test-cache`);
vi.mock("@/integrations/projections/stats-lookup", async (orig) => ({ ...(await orig<typeof import("@/integrations/projections/stats-lookup")>()), defaultStatsCacheDir: () => TMP }));

import { createDb, type Db } from "@/db/client";
import { eq } from "drizzle-orm";
import { draftPicks, league as leagueTable, players } from "@/db/schema";
import { SeasonError, addsUsed, getBrief, createLeagueFromDraft, getAdds, getLeague, getRosters, getTeams, lastYahooSync, loadFreeAgents, sanitizeSettings, setAddsOverride, syncTeamRoster, updateSettings } from "@/db/season";
import { DEFAULT_SEASON_SETTINGS } from "@/engine/season/types";
import { freeAgentsBody, ingestFreeAgents, ingestMatchup, ingestRoster, matchupBody, rosterBody } from "@/server/season-ingest";
import { loadSeasonPlayers, resetSeasonPlayerCache } from "@/server/season-players";
import { computeSeason } from "@/server/season";
import { checkTrade, computeTradeIdeas } from "@/server/season-trades";
import { getOrCreateBrief, renderBriefText } from "@/server/season-brief";
import { storeSchedule } from "@/integrations/schedule/nba-schedule";
import { makeScheduleJson, playerName, seedSeasonLeague } from "./season-fixtures";

let db: Db;
let leagueId: number;
beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  db = createDb(":memory:");
  ({ leagueId } = seedSeasonLeague(db));
});

// Picks go round-robin by snake order: the user (slot 13) holds picks 13, 16, 41, 44 ... -> ids by draft_picks.
const userPlayerIds = () => (getRosters(db, leagueId).get(13) ?? []).map((r) => r.playerId);
const nameOf = (id: string) => playerName(Number(id.slice(2)));
const rows = (ids: string[], slots: string[]) => ids.map((id, i) => ({ playerName: nameOf(id), nbaTeam: db.select().from(players).all().find((p) => p.id === id)?.nbaTeam, slot: slots[i] }));

describe("createLeagueFromDraft", () => {
  it("builds the league, the 14 Yahoo-named teams and every roster from the draft's picks; the user is slot 13", () => {
    const lg = getLeague(db)!;
    expect(lg).toMatchObject({ name: "Test League", teams: 14, userSlot: 13, yahooLeagueKey: "100001/9" });
    expect(lg.settings).toEqual(DEFAULT_SEASON_SETTINGS);
    const teams = getTeams(db, leagueId);
    expect(teams).toHaveLength(14);
    expect(teams[12]).toMatchObject({ slot: 13, name: "Copilot Grizzlies", isUser: true });
    const rosters = getRosters(db, leagueId);
    expect([...rosters.values()].map((r) => r.length)).toEqual(new Array(14).fill(13));
    expect(new Set([...rosters.values()].flat().map((r) => r.playerId)).size).toBe(182);
    expect([...rosters.values()].flat().every((r) => r.source === "draft" && r.status === "active")).toBe(true);
  });
  it("is idempotent per draft; reset re-seeds the rosters but keeps the settings; unknown draft throws", () => {
    updateSettings(db, leagueId, { weeklyAddLimit: 6 });
    const again = createLeagueFromDraft(db, 1);
    expect(again.created).toBe(false);
    expect(again.league.id).toBe(leagueId);
    syncTeamRoster(db, leagueId, 13, [], "manual");
    expect(getRosters(db, leagueId).get(13) ?? []).toHaveLength(0);
    const reset = createLeagueFromDraft(db, 1, { reset: true });
    expect(reset.league.settings.weeklyAddLimit).toBe(6);
    expect(getRosters(db, leagueId).get(13)).toHaveLength(13);
    expect(() => createLeagueFromDraft(db, 999)).toThrow(SeasonError);
  });
});

describe("settings", () => {
  it("defaults are Yahoo standard and sanitized on edit", () => {
    expect(DEFAULT_SEASON_SETTINGS).toMatchObject({ rosterSlots: ["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL"], benchSlots: 3, ilSlots: 2, weeklyAddLimit: 4, lineupLock: "daily" });
    const s = updateSettings(db, leagueId, { rosterSlots: ["pg", "sg", "xx", "g", "sf", "pf", "f", "c", "util"], weeklyAddLimit: 7, ilSlots: 99, lineupLock: "weekly", timezone: "Nope/Zone", bogus: 1 });
    expect(s.rosterSlots).toEqual(["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"]);
    expect(s.weeklyAddLimit).toBe(7);
    expect(s.ilSlots).toBe(6);
    expect(s.lineupLock).toBe("weekly");
    expect(s.timezone).toBe("America/Los_Angeles");
    expect(getLeague(db)!.settings.weeklyAddLimit).toBe(7);
    expect(sanitizeSettings({ rosterSlots: ["PG"] }).rosterSlots).toEqual(DEFAULT_SEASON_SETTINGS.rosterSlots);
  });
});

describe("syncTeamRoster", () => {
  it("adds, drops, moves players between teams and snapshots every sync", () => {
    const mine = userPlayerIds();
    const other = (getRosters(db, leagueId).get(1) ?? [])[0].playerId;
    const next = [...mine.slice(1), other, "pl190"].map((playerId) => ({ playerId, lineupSlot: "BN", status: "bench" as const }));
    const r = syncTeamRoster(db, leagueId, 13, next, "yahoo-page", "2026-11-03T10:00:00Z");
    expect(r.added.sort()).toEqual([other, "pl190"].sort());
    expect(r.dropped).toEqual([mine[0]]);
    expect(r.moved).toEqual([other]);
    expect(getRosters(db, leagueId).get(1)!.some((x) => x.playerId === other)).toBe(false);
    const row = getRosters(db, leagueId).get(13)!.find((x) => x.playerId === "pl190")!;
    expect(row).toMatchObject({ source: "yahoo-page", acquiredAt: "2026-11-03T10:00:00Z", status: "bench" });
    expect(getRosters(db, leagueId).get(13)!.find((x) => x.playerId === mine[1])!.source).toBe("draft"); // stayers keep their origin
    expect(lastYahooSync(db, leagueId, 13)).toBe("2026-11-03T10:00:00Z");
    expect(() => syncTeamRoster(db, leagueId, 99, [], "manual")).toThrow(/Team 99/);
  });
});

describe("Yahoo page ingestion (plausible payloads; real pages need calibration)", () => {
  it("roster: matches by team name, maps slots to status, stores tags, keeps the lineup slot", () => {
    const ids = userPlayerIds();
    const slots = ["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL", "BN", "BN", "IL"];
    const body = rosterBody.parse({ teamName: "Copilot Grizzlies", teamId: "13", players: rows(ids, slots).map((r, i) => ({ ...r, injuryTag: i === 12 ? "INJ" : undefined })) });
    const res = ingestRoster(db, body, "2026-11-03T10:00:00Z");
    expect(res).toMatchObject({ matched: 13, partial: false, team: { slot: 13, isUser: true }, added: [], dropped: [] });
    const mine = getRosters(db, leagueId).get(13)!;
    expect(mine.find((r) => r.playerId === ids[12])).toMatchObject({ lineupSlot: "IL", status: "il" });
    expect(mine.find((r) => r.playerId === ids[10])).toMatchObject({ lineupSlot: "BN", status: "bench" });
    expect(getTeams(db, leagueId)[12].yahooTeamId).toBe("13");
    // the IL player is out according to the page tag, whatever the news feed says
    resetSeasonPlayerCache(db);
    const sp = loadSeasonPlayers(db, leagueId, Date.parse("2026-11-03T11:00:00Z")).players.get(ids[12])!;
    expect(sp.injury).toMatchObject({ flag: "out", tag: "INJ" });
  });
  it("roster: unknown team -> TEAM_NOT_FOUND; 'mine' works without a name; opponents can be synced too", () => {
    const ids = userPlayerIds();
    const pl = rows(ids, new Array(13).fill("BN"));
    expect(() => ingestRoster(db, rosterBody.parse({ teamName: "Nobody FC", players: pl }))).toThrow(/not one of this league/);
    expect(ingestRoster(db, rosterBody.parse({ mine: true, players: pl })).team.name).toBe("Copilot Grizzlies");
    const opp = (getRosters(db, leagueId).get(4) ?? []).map((r) => r.playerId);
    const res = ingestRoster(db, rosterBody.parse({ teamName: "delta fc", players: rows(opp, new Array(13).fill("BN")) }));
    expect(res.team.slot).toBe(4);
  });
  it("roster: unmatched names never drop anybody (partial sync)", () => {
    const ids = userPlayerIds();
    const pl = [...rows(ids.slice(0, 11), new Array(11).fill("BN")), { playerName: "Totally Unknown", slot: "BN" }];
    const res = ingestRoster(db, rosterBody.parse({ mine: true, players: pl }));
    expect(res.partial).toBe(true);
    expect(res.unmatched).toEqual([{ name: "Totally Unknown", reason: "unmatched" }]);
    expect(res.dropped).toEqual([]);
    expect(getRosters(db, leagueId).get(13)).toHaveLength(13);
  });
  it("adds for the weekly limit: the first Yahoo sync is the baseline, later new players count (not before the season starts)", () => {
    storeSchedule(TMP, JSON.stringify(makeScheduleJson("2026-10-20", "2027-04-11")));
    const ids = userPlayerIds();
    const base = rows(ids, new Array(13).fill("BN"));
    ingestRoster(db, rosterBody.parse({ mine: true, players: base }), "2026-10-14T10:00:00Z");
    const withFa = [...base.slice(1), { playerName: playerName(190), slot: "BN" }];
    // preseason: no count
    ingestRoster(db, rosterBody.parse({ mine: true, players: withFa }), "2026-10-15T10:00:00Z");
    expect(getAdds(db, leagueId, "2026-10-12").count).toBe(0);
    // in season (Tue 2026-10-27 18:00Z = Pacific Tuesday): a new player counts for that Monday's week
    const withFa2 = [...withFa.slice(1), { playerName: playerName(191), slot: "BN" }];
    const r = ingestRoster(db, rosterBody.parse({ mine: true, players: withFa2 }), "2026-10-27T18:00:00Z");
    expect(r.addsRecorded).toBe(1);
    expect(getAdds(db, leagueId, "2026-10-26").count).toBe(1);
    expect(addsUsed(setAddsOverride(db, leagueId, "2026-10-26", 3))).toBe(3);
    expect(addsUsed(setAddsOverride(db, leagueId, "2026-10-26", null))).toBe(1);
  });
  it("free agents: stored, matched, pool feeds the add/drop candidates; a draft-time rostered player listed as available is freed", () => {
    const victim = (getRosters(db, leagueId).get(1) ?? [])[0].playerId;
    const faNames = [victim, ...Array.from({ length: 30 }, (_, i) => `pl${182 + i}`)].map((id) => nameOf(id));
    const body = freeAgentsBody.parse({ players: faNames.map((n, i) => ({ yahooId: String(5000 + i), playerName: n, pctOwned: 40 - i, injuryTag: i === 2 ? "INJ" : undefined, stats: { pts: 10 + i } })).concat([{ yahooId: "9999", playerName: "Nobody Atall", pctOwned: 1, injuryTag: undefined, stats: { pts: 1 } }]) });
    const res = ingestFreeAgents(db, body, "2026-11-03T10:00:00Z", TMP);
    expect(res).toMatchObject({ received: 32, matched: 31, freedFromRosters: [victim], created: [] });
    expect(res.unmatched).toEqual([{ name: "Nobody Atall", reason: "unmatched" }]);
    expect(loadFreeAgents(db, leagueId)).toHaveLength(32);
    expect(getRosters(db, leagueId).get(1)).toHaveLength(12);
    // Yahoo ids are remembered on the players so the next match is exact
    expect(db.select().from(players).all().find((p) => p.id === "pl182")!.yahooPlayerKey).toBe("nba.p.5001");
    const o = computeSeason(db, { now: Date.parse("2026-11-03T12:00:00Z"), cacheDir: TMP })!;
    expect(o.moves.faSource).toBe("captured");
    expect(o.moves.faCount).toBe(31);
    expect(o.freshness.freeAgents).toMatchObject({ usable: true, count: 31, unscored: ["Nobody Atall"] });
  });
  it("free agents unknown to the projections are created from NBA stats and scored; without stats they are reported", () => {
    const H = ["PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION", "AGE", "GP", "MIN", "FGM", "FGA", "FG3M", "FTM", "FTA", "REB", "AST", "STL", "BLK", "TOV", "PTS"];
    fs.writeFileSync(path.join(TMP, "nba-stats-2025-26.json"), JSON.stringify({ resultSets: [{ name: "x", headers: H, rowSet: [[1, "Late Signing", "HOU", 30, 60, 24.0, 4, 7, 0.1, 1, 2, 9.5, 1.2, 0.6, 1.4, 1.0, 9]] }] }));
    const names = Array.from({ length: 30 }, (_, i) => nameOf(`pl${182 + i}`)).concat(["Late Signing", "Two Way Rookie"]);
    const body = freeAgentsBody.parse({ players: names.map((n, i) => ({ yahooId: String(6000 + i), playerName: n, nbaTeam: n === "Late Signing" ? "HOU" : undefined, positions: n === "Late Signing" ? "C" : undefined })) });
    const res = ingestFreeAgents(db, body, "2026-11-03T10:00:00Z", TMP);
    expect(res.created).toEqual(["Late Signing"]);
    expect(res.unmatched).toEqual([{ name: "Two Way Rookie", reason: "unmatched" }]);
    const created = db.select().from(players).all().find((p) => p.name === "Late Signing")!;
    expect(created.yahooPlayerKey).toBe("nba.p.6030");
    const o = computeSeason(db, { now: Date.parse("2026-11-03T12:00:00Z"), cacheDir: TMP })!;
    expect(o.moves.faCount).toBe(31);
    expect(o.freshness.freeAgents.unscored).toEqual(["Two Way Rookie"]);
    // the next capture matches him exactly (no duplicate row)
    expect(ingestFreeAgents(db, body, "2026-11-03T14:00:00Z", TMP).created).toEqual([]);
    expect(db.select().from(players).all().filter((p) => p.name === "Late Signing")).toHaveLength(1);
  });
  it("trades: checked by player names (other team found from its players), ideas only where both sides gain", () => {
    const lg = getLeague(db)!;
    const r = getRosters(db, leagueId);
    const mine = r.get(lg.userSlot)!.map((x) => x.playerId);
    const other = [...r.keys()].find((k) => k !== lg.userSlot)!;
    const theirs = r.get(other)!.map((x) => x.playerId);
    const now = Date.parse("2026-11-03T12:00:00Z");
    const e = checkTrade(db, { a: { gives: [nameOf(mine[0])] }, b: { gives: [nameOf(theirs[0])] } }, { now, cacheDir: TMP });
    expect(e.a.slot).toBe(lg.userSlot);
    expect(e.b.slot).toBe(other);
    expect(Number.isFinite(e.a.dRos) && Number.isFinite(e.b.dRos)).toBe(true);
    expect(() => checkTrade(db, { b: { gives: ["Nobody Atall"] } }, { now, cacheDir: TMP })).toThrow(SeasonError);
    const ideas = computeTradeIdeas(db, { now, cacheDir: TMP, limit: 5 })!;
    expect(ideas.ideas.length).toBeLessThanOrEqual(5);
    for (const i of ideas.ideas) expect(i.a.dRos > 0 && i.b.dRos > 0).toBe(true);
  });
  it("matchup: both teams stored, you identified by name; a page without your team is rejected; another week is ignored", () => {
    storeSchedule(TMP, JSON.stringify(makeScheduleJson("2026-10-20", "2027-04-11")));
    const cats = (k: number) => ({ "FG%": 0.47 * k, "FT%": 0.8, "3PTM": 30 * k, PTS: 400 * k, REB: 150, AST: 80, ST: 20, BLK: 10, TO: 40, fgm: 100, fga: 220 });
    const body = matchupBody.parse({ week: 3, teams: [{ name: "Delta FC", cats: cats(1.1) }, { name: "Copilot Grizzlies", cats: cats(1) }] });
    const now = "2026-11-04T18:00:00Z"; // week 3 (Nov 2 - Nov 8)
    const r = ingestMatchup(db, body, now);
    expect(r).toMatchObject({ stored: true, you: "Copilot Grizzlies", opp: "Delta FC", week: 3 });
    const o = computeSeason(db, { now: Date.parse(now), cacheDir: TMP })!;
    expect(o.week).toMatchObject({ matchupCaptured: true, opponent: "Delta FC", number: 3 });
    const pts = o.week.cats.find((c) => c.cat === "PTS")!;
    expect(pts.youCur).toBeCloseTo(400);
    expect(pts.oppCur).toBeCloseTo(440);
    expect(() => ingestMatchup(db, matchupBody.parse({ teams: [{ name: "Alpha FC", cats: {} }, { name: "Bravo FC", cats: {} }] }), now)).toThrow(/not on this matchup page/);
    expect(ingestMatchup(db, matchupBody.parse({ week: 7, teams: body.teams }), now)).toMatchObject({ stored: false });
    // a matchup read last week is not this week's
    const later = computeSeason(db, { now: Date.parse("2026-11-10T18:00:00Z"), cacheDir: TMP })!;
    expect(later.week.matchupCaptured).toBe(false);
  });
});

describe("daily brief storage", () => {
  it("is stored once for the real game day; a preview for another date is neither read from nor written to the store", () => {
    const now = Date.parse("2026-11-03T20:00:00Z");
    const a = getOrCreateBrief(db, { now, cacheDir: TMP })!;
    expect(a).toMatchObject({ created: true, brief: { day: "2026-11-03" } });
    expect(getOrCreateBrief(db, { now, cacheDir: TMP })!.created).toBe(false);
    expect(getOrCreateBrief(db, { now, cacheDir: TMP, force: true })!.created).toBe(true);
    const preview = getOrCreateBrief(db, { now, cacheDir: TMP, date: "2026-11-10" })!;
    expect(preview).toMatchObject({ created: false, brief: { day: "2026-11-10" } });
    expect(getBrief(db, leagueId, "2026-11-10")).toBeNull();
    expect(renderBriefText(a.brief)).toMatch(/^Copilot Grizzlies: 2026-11-03/);
  });
});

describe("computeSeason on the bootstrapped league", () => {
  it("produces lineup, week, moves and freshness without any Yahoo page read (draft rosters, no schedule)", () => {
    const o = computeSeason(db, { now: Date.parse("2026-11-03T12:00:00Z"), cacheDir: TMP })!;
    expect(o.league).toMatchObject({ name: "Test League", userTeam: "Copilot Grizzlies", userSlot: 13 });
    expect(o.lineup.starters.length).toBeGreaterThan(5);
    expect(o.week.cats).toHaveLength(9);
    expect(o.week.addsLimit).toBe(4);
    expect(o.freshness.roster.source).toBe("draft");
    expect(o.freshness.schedule.assumed).toBe(true);
    expect(o.moves.faSource).toBe("all-unrostered");
    expect(o.roster).toHaveLength(13);
  });
  it("with a schedule, players only start on days their team plays", () => {
    storeSchedule(TMP, JSON.stringify(makeScheduleJson("2026-10-20", "2027-04-11")));
    const o = computeSeason(db, { now: Date.parse("2026-11-03T12:00:00Z"), cacheDir: TMP })!;
    expect(o.freshness.schedule.assumed).toBe(false);
    const withGame = new Set(o.roster.filter((r) => r.hasGameToday).map((r) => r.playerId));
    for (const s of o.lineup.starters) expect(withGame.has(s.playerId)).toBe(true);
    expect(o.lineup.gamesToday).toBe(withGame.size);
  });
  it("before opening night the overview and brief are an opening-day preview (an explicit date turns that off)", () => {
    storeSchedule(TMP, JSON.stringify(makeScheduleJson("2026-10-20", "2027-04-11")));
    const now = Date.parse("2026-10-15T18:00:00Z");
    const o = computeSeason(db, { now, cacheDir: TMP })!;
    expect(o).toMatchObject({ preview: true, date: "2026-10-20", realDate: "2026-10-15", seasonStarted: false });
    expect(o.week.number).toBe(1);
    expect(computeSeason(db, { now, cacheDir: TMP, date: "2026-10-15" })!.preview).toBe(false);
    const b = getOrCreateBrief(db, { now, cacheDir: TMP })!.brief;
    expect(b.headline).toContain("opening-day preview 2026-10-20");
    expect(b.sections[0].lines[0]).toMatch(/opening-day preview/);
    expect(getBrief(db, leagueId, "2026-10-15")).not.toBeNull(); // stored under the real day
  });
  it("returns null without a league", () => {
    expect(computeSeason(createDb(":memory:"))).toBeNull();
  });
});

describe("season:init from draft 12 on a copy of the real database", () => {
  const real = path.resolve(__dirname, "..", "data", "fantasy.sqlite");
  it.skipIf(!fs.existsSync(real))("creates the league, 14 teams and 14 rosters of 13 (user: Copilot Grizzlies)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "season-real-"));
    const copy = path.join(dir, "copy.sqlite");
    const src = new Database(real, { readonly: true, fileMustExist: true });
    try {
      src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    const cdb = createDb(copy); // applies the additive migrations to the copy
    cdb.delete(leagueTable).run(); // the copy may already hold a league from `pnpm season:init` (cascades to teams and rosters)
    if (cdb.select().from(draftPicks).where(eq(draftPicks.draftId, 12)).all().length !== 182) return; // the real draft is not in this checkout's database
    const { league, created } = createLeagueFromDraft(cdb, 12);
    expect(created).toBe(true);
    expect(league).toMatchObject({ teams: 14, userSlot: 13, sourceDraftId: 12 });
    const teams = getTeams(cdb, league.id);
    expect(teams[12].name).toBe("Copilot Grizzlies");
    const rosters = getRosters(cdb, league.id);
    expect([...rosters.values()].map((r) => r.length)).toEqual(new Array(14).fill(13));
    const names = new Map(cdb.select().from(players).all().map((p) => [p.id, p.name]));
    expect((rosters.get(13) ?? []).map((r) => names.get(r.playerId)).sort()).toEqual(
      ["Jamal Murray", "Scottie Barnes", "Donovan Clingan", "Trey Murphy III", "Naz Reid", "Dyson Daniels", "Jaime Jaquez Jr.", "Saddiq Bey", "Cason Wallace", "Ayo Dosunmu", "Grayson Allen", "Isaiah Stewart", "Royce O'Neale"].sort(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
