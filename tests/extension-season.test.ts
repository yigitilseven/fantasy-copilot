import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { findMyTeamId, findSeasonPageLinks, findTeamName, parseSeasonMatchup, parseSeasonPlayers, parseSeasonRoster, parseSeasonUrl } from "../extension/parser.js";

/*
 * IMPORTANT: these fixtures are PLAUSIBLE, hand-written Yahoo league-page markup (classic fantasy tables), not real snapshots.
 * They prove the heuristics work on that shape; the real pages must be sent with the overlay's "Send snapshot" and the readers calibrated.
 */
interface Row { playerName: string; yahooId?: string; slot?: string; stats?: Record<string, number>; [k: string]: unknown }
const rowsOf = (r: { rows: unknown }) => r.rows as Row[];
const load = (f: string) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures-extension", f), "utf8")).window.document;

describe("parseSeasonUrl", () => {
  it("classifies league pages and ignores the draft room", () => {
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/nba/100001/13")).toEqual({ kind: "team", leagueId: "100001", teamId: "13" });
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/nba/100001/players?status=A&count=25")).toMatchObject({ kind: "players", leagueId: "100001" });
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/nba/100001/matchup")).toMatchObject({ kind: "matchup" });
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/nba/100001")).toMatchObject({ kind: "other", leagueId: "100001" });
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/draftclient/nba/100001/9").kind).toBe("draft");
    expect(parseSeasonUrl("https://example.com/nba/1/2").kind).toBe("other");
  });
});

describe("parseSeasonRoster (plausible fixture)", () => {
  const doc = load("season-team.html");
  const parsed = parseSeasonRoster(doc);
  const r = { ...parsed, rows: rowsOf(parsed) };
  it("reads the team name and the user's own team id from the nav", () => {
    expect(r.teamName).toBe("Copilot Grizzlies");
    expect(r.myTeamId).toBe("13");
    expect(findMyTeamId(doc)).toBe("13");
    expect(findTeamName(doc)).toBe("Copilot Grizzlies");
  });
  it("reads slot, player, team/positions, tags, opponent and stats; skips empty slots and other tables", () => {
    expect(r.rows.map((x) => x.slot)).toEqual(["PG", "SG", "G", "SF", "C", "BN", "IL"]);
    expect(r.rows[0]).toMatchObject({ playerName: "Jamal Murray", yahooId: "5432", nbaTeam: "DEN", positions: "PG", slot: "PG", opp: "@ LAL", hasGame: true });
    expect(r.rows[0].stats).toMatchObject({ gp: 5, fgPct: 0.481, pts: 25.2, tov: 2.2 });
    expect(r.rows[1]).toMatchObject({ playerName: "Ayo Dosunmu", positions: "SG/PG", hasGame: false });
    expect(r.rows[2]).toMatchObject({ injuryTag: "GTD", opp: "vs SAC" });
    expect(r.rows[3]).toMatchObject({ hasGame: true });
    expect(r.rows[6]).toMatchObject({ playerName: "Isaiah Stewart", slot: "IL", injuryTag: "INJ" });
    expect(r.rows.some((x) => x.playerName === "Some Guy")).toBe(false);
  });
});

describe("parseSeasonPlayers (plausible fixture)", () => {
  const doc = load("season-players.html");
  const parsedP = parseSeasonPlayers(doc);
  const r = { rows: rowsOf(parsedP) };
  it("reads available players with % owned, tags and stats", () => {
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ playerName: "Scoot Henderson", yahooId: "7001", nbaTeam: "POR", positions: "PG", pctOwned: 38 });
    expect(r.rows[0].stats).toMatchObject({ pts: 13.5, ast: 3.6 });
    expect(r.rows[1]).toMatchObject({ injuryTag: "INJ", positions: "C" });
    expect(r.rows[2]).toMatchObject({ positions: "PG/SG", pctOwned: 12 });
    expect(r.rows.every((x) => !x.slot)).toBe(true);
  });
  it("finds only same-list pagination links (same filters and sort, other count)", () => {
    const links = findSeasonPageLinks(doc, "https://basketball.fantasysports.yahoo.com/nba/100001/players?status=A&pos=O&sort=AR&sdir=1&count=0");
    expect(links.map((l: string) => new URL(l).searchParams.get("count"))).toEqual(["25", "50"]);
    expect(links.every((l: string) => l.includes("sort=AR") && l.includes("pos=O"))).toBe(true);
  });
});

describe("parseSeasonMatchup (plausible fixture)", () => {
  it("reads both teams' category totals, made/attempted and the week", () => {
    const r = parseSeasonMatchup(load("season-matchup.html"), "100001");
    expect(r.found).toBe(true);
    expect(r.week).toBe(3);
    expect(r.teams.map((t: { name: string }) => t.name)).toEqual(["Copilot Grizzlies", "Manager AQ"]);
    expect(r.teams[0].cats).toMatchObject({ fgPct: 0.468, ftPct: 0.812, threePm: 31, pts: 402, reb: 160, ast: 88, stl: 25, blk: 14, tov: 41, fgm: 150, fga: 320 });
    expect(r.teams[1].cats).toMatchObject({ pts: 455, tov: 52, fgm: 160, fga: 352 });
  });
  it("reports not found on an unrelated page", () => {
    expect(parseSeasonMatchup(load("season-players.html")).found).toBe(false);
  });
});
