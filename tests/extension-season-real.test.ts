/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { discoverLeague, findLeagueLinkByText, findMatchupLink, findMyTeamId, findNextPageLink, findTeamName, findTransactionsLink, parseMatchupGames, parseSeasonMatchup, parseSeasonPlayers, parseSeasonRoster } from "../extension/parser.js";

/* Fixtures trimmed from REAL Yahoo snapshots of league 100001 (2026-10-22): My Team (team 9), Matchup (9 vs 13), Players. */
const load = (f: string) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures-season-real", f), "utf8")).window.document;
const BASE = "https://basketball.fantasysports.yahoo.com";

describe("real My Team page", () => {
  const doc = load("team.html");
  const r = parseSeasonRoster(doc) as any;
  it("reads the 13 players with Yahoo ids from absolute sports.yahoo.com links, slots, team/positions and the status tag", () => {
    expect(r.rows.map((x: { playerName: string }) => x.playerName)).toEqual(["Jamal Murray", "Cason Wallace", "Dyson Daniels", "Grayson Allen", "Naz Reid", "Jaime Jaquez Jr.", "Scottie Barnes", "Donovan Clingan", "Saddiq Bey", "Royce O'Neale", "Ayo Dosunmu", "Trey Murphy III", "Isaiah Stewart"]);
    expect(r.rows.map((x: { slot: string }) => x.slot)).toEqual(["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL", "BN", "BN", "BN"]);
    expect(r.rows[0]).toMatchObject({ yahooId: "5638", nbaTeam: "DEN", positions: "PG", hasGame: true, opp: "@OKC" });
    expect(r.rows[1]).toMatchObject({ yahooId: "10107", positions: "PG/SG/SF" });
    expect(r.rows[12]).toMatchObject({ playerName: "Isaiah Stewart", injuryTag: "Q", slot: "BN" });
    expect(r.rows[0].pctOwned).toBe(100);
  });
  it("reads the team name from the roster caption (not the league name) and my team id from the nav", () => {
    expect(r.teamName).toBe("Copilot Grizzlies");
    expect(findTeamName(doc)).toBe("Copilot Grizzlies");
    expect(r.myTeamId).toBe("9");
    expect(findMyTeamId(doc)).toBe("9");
  });
  it("discovers the league: id, my team, and all 14 teams (switcher + own page) with names", () => {
    const d = discoverLeague(doc, `${BASE}/nba/100001/9`);
    expect(d).toMatchObject({ leagueId: "100001", myTeamId: "9" });
    expect(d.teams).toHaveLength(14);
    expect(d.teams.find((t: { id: string }) => t.id === "13")).toEqual({ id: "13", name: "Manager BG" });
    expect(d.teams.find((t: { id: string }) => t.id === "9")).toEqual({ id: "9", name: "Copilot Grizzlies" });
    expect(d.teams.find((t: { id: string }) => t.id === "2")?.name).toBe("Drafter AA");
  });
  it("follows the site's own navigation links", () => {
    const u = `${BASE}/nba/100001/9`;
    expect(findMatchupLink(doc, "100001", u)).toBe(`${BASE}/nba/100001/matchup`);
    expect(findTransactionsLink(doc, "100001", u)).toBe(`${BASE}/nba/100001/transactions`);
    expect(findLeagueLinkByText(doc, "100001", /^standings$/i, u)).toBe(`${BASE}/nba/100001?lhst=stand#leaguehomestandings`);
  });
});

describe("real Matchup page", () => {
  const doc = load("matchup.html");
  const m = parseSeasonMatchup(doc, "100001");
  it("reads both teams' totals from the category table", () => {
    expect(m).toMatchObject({ found: true, layout: "header-table", week: 1 });
    expect(m.teams.map((t: { name: string; id: string }) => [t.name, t.id])).toEqual([["Copilot Grizzlies", "9"], ["Manager BG", "13"]]);
    expect(m.teams[0].cats).toEqual({ fgm: 62, fga: 128, fgPct: 0.484, ftm: 27, fta: 32, ftPct: 0.844, threePm: 20, pts: 171, reb: 59, ast: 29, stl: 7, blk: 1, tov: 16 });
    expect(m.teams[1].cats).toEqual({ fgm: 59, fga: 115, fgPct: 0.513, ftm: 31, fta: 41, ftPct: 0.756, threePm: 14, pts: 163, reb: 59, ast: 41, stl: 14, blk: 7, tov: 22 });
  });
  it("reads games played and remaining for each side", () => {
    expect(parseMatchupGames(doc)).toEqual({ gamesPlayed: [11, 12], gamesRemaining: [24, 18] });
    expect(m.teams[0]).toMatchObject({ gamesPlayed: 11, gamesRemaining: 24 });
    expect(m.teams[1]).toMatchObject({ gamesPlayed: 12, gamesRemaining: 18 });
  });
});

describe("real Players page", () => {
  const doc = load("players.html");
  const rows = parseSeasonPlayers(doc).rows as { playerName: string; yahooId: string; pctOwned?: number; stats?: Record<string, number>; nbaTeam?: string }[];
  it("reads available players with % rostered and last-game stats", () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toMatchObject({ playerName: "Kris Dunn", yahooId: "5636", nbaTeam: "LAC", pctOwned: 4 });
    expect(rows[0].stats).toMatchObject({ gp: 1, fgPct: 0.4, ftPct: 0.5, threePm: 2, pts: 7, reb: 5, ast: 7, stl: 3, blk: 2, tov: 2 });
  });
  it("follows the page's own Next link", () => {
    const next = findNextPageLink(doc, `${BASE}/nba/100001/players?status=A&eteam=ALL&fteam=NONE&pos=P&cut_type=33&stat1=S_AS_2026&myteam=0&sort=AR&sdir=1`);
    expect(next).toContain("count=25");
    expect(next).toContain("sort=AR");
  });
});
