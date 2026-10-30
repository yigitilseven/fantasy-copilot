import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { getAllPlayerRecords } from "@/db/repository";
import { yahooProjections } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import {
  AVAILABILITY_SHRINK, DEFAULT_PROJECTION_WEIGHT, MIN_ACTUAL_GP, TYPICAL_GAMES, applyProjectionBlend, availabilityGames, blendLines, projectionDisagreement,
} from "@/engine/projection/blend";
import { computeValuations } from "@/engine/valuation/value";
import { scorePlayers } from "@/engine/recommendation/score";
import { makeStrategy } from "@/engine/recommendation/strategy";
import type { PlayerRecord, ProjectionLine } from "@/types";
import { makeRecord } from "./fixtures";

const line = (o: Partial<ProjectionLine> = {}): ProjectionLine => ({
  games: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, ...o,
});

/** A record whose current projection is the Yahoo line and which carries both components. */
function rec(id: string, yahoo: ProjectionLine | null, actual: ProjectionLine | null, rank = 50): PlayerRecord {
  const base = makeRecord({ id, market: { rank, yahooAdp: rank } });
  const cur = yahoo ?? actual ?? line();
  return { ...base, projection: { ...base.projection, ...cur, playerId: id, projectionSource: yahoo ? "yahoo-2026-27" : "nba-stats", components: { yahoo, actual } } };
}

describe("blendLines", () => {
  const y = line({ pts: 24, fgm: 9, fga: 18, ftm: 6, fta: 7, games: 72 });
  const a = line({ pts: 18, fgm: 6, fga: 14, ftm: 2, fta: 5, games: 60 });

  it("mixes every per-game field with w / (1 - w)", () => {
    const { line: l, info } = blendLines(y, a, 0.6)!;
    expect(l.pts).toBeCloseTo(0.6 * 24 + 0.4 * 18);
    expect(l.reb).toBeCloseTo(5);
    expect(info).toMatchObject({ weight: 0.6, effectiveWeight: 0.6 });
    expect(info.reason).toBeUndefined();
  });

  it("blends attempts and makes separately so FG% / FT% stay Σmakes/Σattempts", () => {
    const { line: l } = blendLines(y, a, 0.6)!;
    expect(l.fgm).toBeCloseTo(0.6 * 9 + 0.4 * 6);
    expect(l.fga).toBeCloseTo(0.6 * 18 + 0.4 * 14);
    const fg = l.fgm / l.fga;
    // volume-weighted, i.e. NOT the plain 60/40 mix of the two percentages
    const naive = 0.6 * (9 / 18) + 0.4 * (6 / 14);
    expect(fg).toBeCloseTo(7.8 / 16.4, 10);
    expect(Math.abs(fg - naive)).toBeGreaterThan(1e-4);
    expect(fg).toBeGreaterThan(Math.min(9 / 18, 6 / 14));
    expect(fg).toBeLessThan(Math.max(9 / 18, 6 / 14));
    expect(l.ftm / l.fta).toBeCloseTo((0.6 * 6 + 0.4 * 2) / (0.6 * 7 + 0.4 * 5), 10);
  });

  it("games = w·YahooGP + (1-w)·availability estimate (documented shrinkage of last season's GP)", () => {
    expect(availabilityGames(60)).toBeCloseTo((1 - AVAILABILITY_SHRINK) * 60 + AVAILABILITY_SHRINK * TYPICAL_GAMES);
    expect(availabilityGames(200)).toBe(82);
    const { line: l } = blendLines(y, a, 0.5)!;
    expect(l.games).toBeCloseTo(0.5 * 72 + 0.5 * availabilityGames(60));
  });

  it("endpoints return the source lines", () => {
    expect(blendLines(y, a, 1)!.line).toBe(y);
    expect(blendLines(y, a, 0)!.line).toBe(a);
  });

  it("reliability: < 25 GP, no actual line -> Yahoo only; no Yahoo -> actual only; neither -> null", () => {
    const low = blendLines(y, line({ games: MIN_ACTUAL_GP - 1 }), 0.4)!;
    expect(low.info).toMatchObject({ effectiveWeight: 1, reason: "low-gp" });
    expect(low.line).toBe(y);
    expect(blendLines(y, line({ games: MIN_ACTUAL_GP }), 0.4)!.info.effectiveWeight).toBe(0.4);
    expect(blendLines(y, null, 0.4)!.info).toMatchObject({ effectiveWeight: 1, reason: "no-actual" });
    expect(blendLines(null, a, 0.4)!.info).toMatchObject({ effectiveWeight: 0, reason: "no-yahoo" });
    expect(blendLines(null, a, 0.4)!.line).toBe(a);
    expect(blendLines(null, null, 0.4)).toBeNull();
  });

  it("the default weight is 0.6", () => expect(DEFAULT_PROJECTION_WEIGHT).toBe(0.6));
});

describe("applyProjectionBlend", () => {
  const y = line({ pts: 24 });
  const a = line({ pts: 16 });

  it("exposes projectionSource 'blend' and the components", () => {
    const [r] = applyProjectionBlend([rec("a", y, a)], 0.6);
    expect(r.projection.projectionSource).toBe("blend");
    expect(r.projection.pts).toBeCloseTo(0.6 * 24 + 0.4 * 16);
    expect(r.projection.blend).toMatchObject({ weight: 0.6, effectiveWeight: 0.6, yahoo: y, actual: a });
    expect(r.projection.components).toEqual({ yahoo: y, actual: a });
  });

  it("is the identity at w=1 and when no record has a Yahoo projection", () => {
    const recs = [rec("a", y, a)];
    expect(applyProjectionBlend(recs, 1)).toBe(recs);
    const noYahoo = [rec("b", null, a)];
    expect(applyProjectionBlend(noYahoo, 0.6)).toBe(noYahoo);
  });

  it("rookies / low-GP players keep the Yahoo record; Yahoo-less players use the actual line; w=0 is the actual line", () => {
    const out = applyProjectionBlend([rec("rookie", y, null), rec("hurt", y, line({ games: 12, pts: 30 })), rec("noy", null, a), rec("ok", y, a)], 0.6);
    expect(out[0].projection).toMatchObject({ projectionSource: "yahoo-2026-27", pts: 24, blend: { reason: "no-actual", effectiveWeight: 1 } });
    expect(out[1].projection).toMatchObject({ projectionSource: "yahoo-2026-27", pts: 24, blend: { reason: "low-gp" } });
    expect(out[2].projection.pts).toBe(16);
    const zero = applyProjectionBlend([rec("ok", y, a)], 0)[0].projection;
    expect(zero.pts).toBe(16);
    expect(zero.projectionSource).toBe("nba-stats");
  });

  it("clamps / defaults a bad weight", () => {
    expect(applyProjectionBlend([rec("a", y, a)], 7)).toHaveLength(1); // clamps to 1 -> identity
    expect(applyProjectionBlend([rec("a", y, a)], Number.NaN)[0].projection.blend?.weight).toBe(0.6);
  });
});

describe("projectionDisagreement + robustness penalty", () => {
  /** Two players with the SAME blended line at w=0.5: A is consistent, B is Yahoo-high / actual-low. */
  function universe() {
    const out: PlayerRecord[] = [];
    for (let i = 0; i < 80; i++) {
      const q = 1 - i / 80;
      const l = line({ pts: 8 + 18 * q, reb: 3 + 7 * q, ast: 1 + 5 * q, threePm: 0.5 + 2 * q, stl: 0.5 + q, blk: 0.2 + q, tov: 1 + 2 * q });
      out.push(rec(`f${i}`, l, l, i + 3));
    }
    const mid = line({ pts: 26, reb: 9, ast: 6, threePm: 2.5, stl: 1.5, blk: 1.2 });
    out.push(rec("consistent", mid, mid, 1));
    out.push(rec("volatile", line({ pts: 32, reb: 12, ast: 8, threePm: 3.4, stl: 2, blk: 1.8 }), line({ pts: 20, reb: 6, ast: 4, threePm: 1.6, stl: 1, blk: 0.6 }), 2));
    return out;
  }

  it("is 0 for players with a single source or few games, and large for the volatile one", () => {
    const recs = [...universe(), rec("rk", line(), null, 90), rec("lowgp", line(), line({ games: 10 }), 91)];
    const d = projectionDisagreement(recs);
    expect(d.rk ?? 0).toBe(0);
    expect(d.lowgp ?? 0).toBe(0);
    expect(d.volatile).toBeGreaterThan(1);
    expect(d.consistent).toBeLessThan(d.volatile / 2); // not exactly 0: the volatile player shifts each source's pool means
  });

  it("with robustness on, the consistent player outranks the volatile one at equal blended value; off by default", () => {
    const blended = applyProjectionBlend(universe(), 0.5);
    const val = computeValuations(blended).valuations;
    const a = blended.find((r) => r.player.id === "consistent")!.projection;
    const b = blended.find((r) => r.player.id === "volatile")!.projection;
    expect(b.pts).toBeCloseTo(a.pts); // identical blended lines
    const dis = projectionDisagreement(universe());
    const base = { records: blended, valuations: val, draftedIds: [], userRosterIds: [], currentPick: 1, userNextPick: 20, isUserOnClock: true, survival: null, now: 0 };
    const score = (strategy?: ReturnType<typeof makeStrategy>, disagreement?: Record<string, number>) => {
      const s = scorePlayers({ ...base, strategy, disagreement });
      const get = (id: string) => s.find((x) => x.playerId === id)!;
      return { a: get("consistent"), b: get("volatile") };
    };
    const off = score(makeStrategy("balanced"), dis);
    expect(off.a.draftScore).toBeCloseTo(off.b.draftScore, 6);
    const on = score(makeStrategy("balanced", undefined, undefined, { robustness: 0.5 }), dis);
    expect(on.a.draftScore).toBeGreaterThan(on.b.draftScore + 0.5);
    // no disagreement map supplied -> no penalty even when the strategy asks for it
    const none = score(makeStrategy("balanced", undefined, undefined, { robustness: 0.5 }), undefined);
    expect(none.a.draftScore).toBeCloseTo(none.b.draftScore, 6);
  });
});

describe("getAllPlayerRecords components", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blend-cache-"));
  const headers = ["PLAYER_NAME", "TEAM_ABBREVIATION", "AGE", "GP", "MIN", "FGM", "FGA", "FTM", "FTA", "FG3M", "REB", "AST", "TOV", "STL", "BLK", "PTS"];
  fs.writeFileSync(
    path.join(dir, "nba-stats-2025-26.json"),
    JSON.stringify({ resultSets: [{ name: "LeagueDashPlayerStats", headers, rowSet: [
      ["Test Veteran", "AAA", 28, 70, 33, 7, 15, 4, 5, 2, 6, 5, 2, 1, 0.5, 20],
      ["Test Injured", "BBB", 25, 12, 30, 8, 16, 4, 5, 2, 6, 5, 2, 1, 0.5, 22],
    ] }] }),
  );
  const yrow = (id: string, name: string, pts: number) => ({
    yahooId: `y-${id}`, playerId: id, name, nbaTeam: "AAA", positions: "SF", gp: 70, fgPct: 0.5, ftPct: 0.8, threePm: 140, pts, reb: 420, ast: 280, stl: 70, blk: 35, tov: 140,
    xrank: 1, rank: 1, adp: 20, season: "2026-27", capturedAt: "2026-10-09T00:00:00Z",
  });
  const db = createDb(":memory:");
  seedFromRecords(db, [
    makeRecord({ id: "vet", name: "Test Veteran" }),
    makeRecord({ id: "hurt", name: "Test Injured" }),
    makeRecord({ id: "rook", name: "Test Rookie" }),
  ]);
  db.insert(yahooProjections).values([yrow("vet", "Test Veteran", 1750), yrow("hurt", "Test Injured", 1750), yrow("rook", "Test Rookie", 1750)]).run();

  it("is unchanged without opts (no components); attaches Yahoo + actual lines with withComponents", () => {
    expect(getAllPlayerRecords(db).every((r) => r.projection.components === undefined)).toBe(true);
    const recs = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir });
    const vet = recs.find((r) => r.player.id === "vet")!.projection;
    expect(vet.projectionSource).toBe("yahoo-2026-27");
    expect(vet.components!.yahoo!.pts).toBeCloseTo(25);
    expect(vet.components!.actual).toMatchObject({ games: 70, pts: 20, fga: 15 });
    expect(recs.find((r) => r.player.id === "rook")!.projection.components!.actual).toBeNull();
  });

  it("projectionWeight blends; rookies and < 25 GP players stay on Yahoo", () => {
    const recs = getAllPlayerRecords(db, Date.now(), { projectionWeight: 0.5, statsCacheDir: dir });
    const by = (id: string) => recs.find((r) => r.player.id === id)!.projection;
    expect(by("vet").projectionSource).toBe("blend");
    expect(by("vet").pts).toBeCloseTo((25 + 20) / 2);
    expect(by("hurt").projectionSource).toBe("yahoo-2026-27");
    expect(by("hurt").pts).toBeCloseTo(25);
    expect(by("rook").pts).toBeCloseTo(25);
  });

  it("falls back to the existing nba-stats projection when the stats cache file is missing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "blend-empty-"));
    const vet = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: empty }).find((r) => r.player.id === "vet")!.projection;
    expect(vet.components!.actual).toMatchObject({ pts: 15, games: 75 }); // makeRecord defaults
  });
});
