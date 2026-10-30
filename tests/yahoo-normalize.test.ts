import { describe, expect, it } from "vitest";
import {
  leagueKeyOfTeam,
  listOf,
  mergeParts,
  normalizeDraftResults,
  normalizeGame,
  normalizeLeagues,
  normalizePlayers,
  normalizeSettings,
  normalizeSinglePlayer,
  normalizeTeams,
  num,
} from "@/integrations/yahoo/normalize";
import { fixture } from "./yahoo-helpers";

describe("primitive helpers", () => {
  it("listOf unwraps keyed collections in numeric order and ignores count", () => {
    expect(listOf({ "1": "b", "0": "a", "10": "c", count: 3 })).toEqual(["a", "b", "c"]);
    expect(listOf([1, 2])).toEqual([1, 2]);
    expect(listOf(null)).toEqual([]);
  });
  it("mergeParts flattens nested arrays, empty arrays and passes objects through", () => {
    expect(mergeParts([[{ a: 1 }, [], { b: 2 }], {}, { c: 3 }])).toEqual({ a: 1, b: 2, c: 3 });
    expect(mergeParts({ x: 1 })).toEqual({ x: 1 });
    expect(mergeParts("nope")).toEqual({});
  });
  it("num treats dashes/blank as missing", () => {
    expect(num("-")).toBeNull();
    expect(num("")).toBeNull();
    expect(num(".563")).toBe(0.563);
    expect(num("1,234")).toBe(1234);
    expect(num(7)).toBe(7);
    expect(num(undefined)).toBeNull();
  });
});

describe("fixtures", () => {
  it("game", () => {
    expect(normalizeGame(fixture("game-nba.json"))).toEqual({ gameKey: "466", season: 2026, code: "nba" });
  });

  it("players page: info flattening, positions, draft_analysis in both shapes, percent_owned", () => {
    const ps = normalizePlayers(fixture("players-or-page1.json"));
    expect(ps).toHaveLength(5);
    const [jokic, sga, wemby, flagg, kawhi] = ps;
    expect(jokic).toMatchObject({ playerKey: "466.p.5352", name: "Nikola Jokic", teamAbbr: "Den", averagePick: 1.3, percentOwned: 100, status: null });
    expect(jokic.eligiblePositions).toEqual(["C", "Util"]);
    // object-form draft_analysis
    expect(sga).toMatchObject({ averagePick: 2.4, averageRound: 1, hasDraftAnalysis: true });
    expect(sga.eligiblePositions).toEqual(["PG", "SG", "G", "Util"]);
    expect(wemby.teamAbbr).toBe("SA");
    expect(flagg.averagePick).toBe(41.5);
    // "-" ADP stays null but the sub-resource is recognized
    expect(kawhi).toMatchObject({ averagePick: null, hasDraftAnalysis: true, status: "INJ", injuryNote: "Knee: out indefinitely", percentOwned: 61 });
  });

  it("season stats collection yields stat-id maps; empty stats stay empty", () => {
    const ps = normalizePlayers(fixture("players-stats-season-2025.json"));
    const jokic = ps.find((p) => p.name === "Nikola Jokic")!;
    expect(jokic.statsMeta).toEqual({ coverageType: "season", season: "2025" });
    expect(jokic.stats).toMatchObject({ "0": "70", "9004003": "800/1420", "5": ".563", "12": "2115" });
    expect(ps.find((p) => p.name === "Cooper Flagg")!.stats).toEqual({});
  });

  it("single-player response", () => {
    const p = normalizeSinglePlayer(fixture("player-season-2025-wemby.json"))!;
    expect(p.name).toBe("Victor Wembanyama");
    expect(p.stats!["18"]).toBe("200");
    expect(normalizeSinglePlayer({})).toBeNull();
  });

  it("leagues, teams (user slot), settings (rounds exclude IL), draft results", () => {
    const leagues = normalizeLeagues(fixture("users-leagues.json"));
    expect(leagues.map((l) => [l.leagueKey, l.numTeams, l.draftStatus])).toEqual([
      ["466.l.12345", 14, "predraft"],
      ["466.l.67890", 10, "postdraft"],
    ]);
    const teams = normalizeTeams(fixture("users-teams.json"));
    expect(teams[0]).toMatchObject({ teamKey: "466.l.12345.t.6", leagueKey: "466.l.12345", isOwnedByCurrentLogin: true, draftPosition: 6 });
    expect(leagueKeyOfTeam("466.l.12345.t.6")).toBe("466.l.12345");
    const s = normalizeSettings(fixture("league-settings.json"));
    expect(s).toMatchObject({ numTeams: 14, draftType: "live", isAuctionDraft: false, draftStatus: "predraft", rounds: 13 });
    const dr = normalizeDraftResults(fixture("league-draftresults.json"));
    expect(dr).toHaveLength(7);
    expect(dr[0]).toEqual({ pick: 1, round: 1, teamKey: "466.l.12345.t.1", yahooPlayerKey: "466.p.5352" });
    expect(dr[6].yahooPlayerKey).toBeNull();
  });

  it("tolerates garbage", () => {
    expect(normalizePlayers({})).toEqual([]);
    expect(normalizeDraftResults(null)).toEqual([]);
    expect(() => normalizeGame({})).toThrow(/game_key/);
  });
});
