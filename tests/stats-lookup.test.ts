import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { createDraft, getDraft } from "@/db/repository";
import { players, playerProjections } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { ingestDomPicks, matchPlayer } from "@/integrations/yahoo/dom-ingest";
import { lookupCachedStats, resetStatsLookupCache } from "@/integrations/projections/stats-lookup";
import { eq } from "drizzle-orm";
import { makeRecord } from "./fixtures";

const H = ["PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION", "AGE", "GP", "MIN", "FGM", "FGA", "FG3M", "FTM", "FTA", "REB", "AST", "STL", "BLK", "TOV", "PTS"];
const nba = (rows: unknown[][]) => JSON.stringify({ resultSets: [{ name: "x", headers: H, rowSet: rows }] });
const idx = (rows: unknown[][]) => JSON.stringify({ resultSets: [{ name: "PlayerIndex", headers: ["PERSON_ID", "PLAYER_LAST_NAME", "PLAYER_FIRST_NAME", "TEAM_ABBREVIATION", "POSITION"], rowSet: rows }] });

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-lookup-"));
  fs.writeFileSync(path.join(dir, "nba-stats-2025-26.json"), nba([
    [1, "Caris LeVert", "DET", 31, 60, 21.0, 3.0, 7.0, 1.0, 1.0, 1.5, 2.5, 3.0, 0.8, 0.5, 1.2, 8.0],
    [2, "Jalen Williams", "OKC", 24, 70, 32.0, 7, 14, 2, 4, 5, 5, 5, 1.5, 0.6, 2, 20],
    [3, "Jaylin Williams", "OKC", 24, 40, 15.0, 2, 4, 1, 1, 2, 4, 2, 0.5, 0.3, 0.8, 5],
    [4, "Jalen Williams", "PHX", 24, 50, 25.0, 4, 9, 1, 2, 3, 4, 3, 1, 0.5, 1, 11],
  ]));
  fs.writeFileSync(path.join(dir, "nba-stats-2024-25.json"), nba([[1, "Caris LeVert", "CLE", 30, 70, 24.0, 4.0, 9.0, 1.5, 2.0, 2.5, 3.5, 4.0, 1.0, 0.4, 1.5, 11.5]]));
  fs.writeFileSync(path.join(dir, "nba-playerindex-2025-26.json"), idx([[1, "LeVert", "Caris", "DET", "G-F"]]));
});
beforeEach(() => resetStatsLookupCache());

describe("lookupCachedStats", () => {
  it("finds by initial + last name and blends the two seasons", () => {
    const r = lookupCachedStats({ playerName: "C. LeVert", nbaTeam: "MIL" }, dir)!;
    expect(r).toMatchObject({ name: "Caris LeVert", team: "DET", age: 31, positions: ["SG", "SF"] });
    expect(r.line.pts).toBeCloseTo(0.7 * 8 + 0.3 * 11.5, 9);
    expect(r.line.fgm).toBeLessThan(r.line.fga);
    expect(r.games).toBe(Math.round(Math.min(76, (0.6 * 60 + 0.4 * 70) * 0.6 + 28)));
  });
  it("disambiguates namesakes by team and refuses to guess otherwise", () => {
    expect(lookupCachedStats({ playerName: "Jalen Williams", nbaTeam: "PHX" }, dir)!.line.pts).toBe(11);
    expect(lookupCachedStats({ playerName: "J. Williams" }, dir)).toBeNull();
    expect(lookupCachedStats({ playerName: "Nobody Atall", nbaTeam: "BOS" }, dir)).toBeNull();
  });
  it("never throws: missing dir, corrupt file", () => {
    expect(lookupCachedStats({ playerName: "C. LeVert" }, path.join(dir, "nope"))).toBeNull();
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "stats-bad-"));
    fs.writeFileSync(path.join(bad, "nba-stats-2025-26.json"), "{not json");
    expect(lookupCachedStats({ playerName: "C. LeVert" }, bad)).toBeNull();
  });
  it("parses once per file (in-process cache)", () => {
    const a = lookupCachedStats({ playerName: "C. LeVert" }, dir);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) lookupCachedStats({ playerName: "C. LeVert" }, dir);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(lookupCachedStats({ playerName: "C. LeVert" }, dir)).toEqual(a);
  });
});

describe("dom-ingest placeholders", () => {
  let db: Db;
  let id: number;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, [makeRecord({ id: "jokic", name: "Nikola Jokic", positions: ["C"], market: { rank: 1 } })]);
    id = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
    resetStatsLookupCache();
  });

  it("builds a real projection for an unknown player found in the stats cache (keeps the yahoo- id, Yahoo's team)", () => {
    const r = ingestDomPicks({ db, draftId: id, statsCacheDir: dir, picks: [{ pick: 1, playerName: "C. LeVert", nbaTeam: "MIL" }] });
    expect(r.autoResolved).toEqual([{ pick: 1, name: "C. LeVert", resolution: "placeholder", playerId: "yahoo-c-levert-mil" }]);
    const p = db.select().from(players).where(eq(players.id, "yahoo-c-levert-mil")).get()!;
    expect(p).toMatchObject({ name: "Caris LeVert", nbaTeam: "MIL" });
    expect(p.positions).toBe("SG/SF");
    const pr = db.select().from(playerProjections).where(eq(playerProjections.playerId, "yahoo-c-levert-mil")).get()!;
    expect(pr.pts).toBeCloseTo(0.7 * 8 + 0.3 * 11.5, 6);
    expect(pr.games).toBeGreaterThan(0);
  });
  it("falls back to zeros when the player is unknown, the dir is missing, or the lookup is ambiguous", () => {
    for (const [name, cache] of [["Mystery Rookie", dir], ["C. LeVert", "/nonexistent/dir"], ["J. Williams", dir]] as const) {
      const d2 = createDb(":memory:");
      seedFromRecords(d2, [makeRecord({ id: "jokic", name: "Nikola Jokic", positions: ["C"], market: { rank: 1 } })]);
      const id2 = createDraft(d2, { teams: 4, userSlot: 1, rounds: 3 }).id;
      const r = ingestDomPicks({ db: d2, draftId: id2, statsCacheDir: cache, picks: [{ pick: 1, playerName: name, nbaTeam: "SAS", positions: "SG" }] });
      const pid = r.autoResolved[0].playerId;
      expect(getDraft(d2, id2)!.picks).toHaveLength(1);
      expect(d2.select().from(playerProjections).where(eq(playerProjections.playerId, pid)).get()).toMatchObject({ pts: 0, games: 0 });
    }
  });
});

describe("matchPlayer: real players beat yahoo- placeholders", () => {
  const rec = (id: string, team: string, adp: number) => ({ id, name: "Caris LeVert", nbaTeam: team, positions: "SG/SF", adp });
  const index = (ps: ReturnType<typeof rec>[]) => new Map([["~c|levert", ps], ["caris levert", ps]]);
  it("resolves C. LeVert (MIL) to the real DET row, not the placeholder with the matching team", () => {
    const m = matchPlayer(index([rec("caris-levert", "DET", 280), rec("yahoo-c-levert-mil", "MIL", 999)]), { playerName: "C. LeVert", nbaTeam: "MIL" });
    expect(m).toMatchObject({ ok: true, player: { id: "caris-levert" } });
  });
  it("still resolves to a placeholder when it is the only candidate", () => {
    expect(matchPlayer(index([rec("yahoo-c-levert-mil", "MIL", 999)]), { playerName: "C. LeVert", nbaTeam: "MIL" })).toMatchObject({ ok: true, player: { id: "yahoo-c-levert-mil" } });
  });
});
