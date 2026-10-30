import { describe, expect, it } from "vitest";
import { applyProjectionBlend } from "@/engine/projection/blend";
import { AUTO_LAMBDA, EARLY_MAX_ROUND, LATE_MIN_ROUND, lateness, lineDistance, roundAwareValue, sourceZ, type SourceZ } from "@/engine/projection/disagreement";
import { scorePlayers } from "@/engine/recommendation/score";
import { makeStrategy } from "@/engine/recommendation/strategy";
import { computeValuations } from "@/engine/valuation/value";
import { CATEGORIES, type CategoryScores, type PlayerRecord, type ProjectionLine } from "@/types";
import { makeRecord } from "./fixtures";

const z = (o: Partial<CategoryScores> = {}): CategoryScores => ({ ...(Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as CategoryScores), ...o });

describe("lineDistance", () => {
  it("is the L1 distance of the 9-cat profiles divided by 3", () => {
    expect(lineDistance({ proj: z(), real: z() })).toBe(0);
    expect(lineDistance({ proj: z({ PTS: 1 }), real: z() })).toBeCloseTo(1 / 3);
    expect(lineDistance({ proj: z(Object.fromEntries(CATEGORIES.map((c) => [c, 1]))), real: z() })).toBeCloseTo(3);
  });
  it("sees a changed build that the totals hide, and ignores punted categories", () => {
    const swap: SourceZ = { proj: z({ PTS: 1.5, AST: -1.5 }), real: z() };
    expect(lineDistance(swap)).toBeCloseTo(1);
    const e = z(Object.fromEntries(CATEGORIES.map((c) => [c, 1])));
    expect(lineDistance(swap, { ...e, AST: 0 })).toBeCloseTo(0.5);
  });
});

describe("round-aware value", () => {
  const src: SourceZ = { proj: z({ PTS: 3, REB: 1 }), real: z({ PTS: 1 }) }; // d = (2 + 1) / 3 = 1; sums 4 and 1
  const blend = 2.5;
  it("lateness is 0 through round 6, 1 from round 10, linear in between", () => {
    expect([1, 6].map(lateness)).toEqual([0, 0]);
    expect([10, 13].map(lateness)).toEqual([1, 1]);
    expect([7, 8, 9].map(lateness)).toEqual([0.25, 0.5, 0.75]);
    expect(EARLY_MAX_ROUND).toBe(6);
    expect(LATE_MIN_ROUND).toBe(10);
  });
  it("rounds 1-6: penalty lambda * d", () => {
    for (const round of [1, 3, 6]) expect(roundAwareValue({ blend, src, round })).toBeCloseTo(blend - AUTO_LAMBDA * 1);
    expect(roundAwareValue({ blend, src, round: 1, lambda: 0.2 })).toBeCloseTo(blend - 0.2);
  });
  it("rounds >= 10: upside = max(blend, 0.5 blend + 0.5 max(proj, real)); never below the blend", () => {
    expect(roundAwareValue({ blend, src, round: 10 })).toBeCloseTo(0.5 * blend + 0.5 * 4);
    expect(roundAwareValue({ blend, src, round: 13 })).toBeCloseTo(3.25);
    expect(roundAwareValue({ blend: 5, src, round: 11 })).toBe(5); // blend already above both sources
  });
  it("rounds 7-9 interpolate linearly between the early and the late value", () => {
    const early = roundAwareValue({ blend, src, round: 6 });
    const late = roundAwareValue({ blend, src, round: 10 });
    for (const [round, t] of [[7, 0.25], [8, 0.5], [9, 0.75]] as const) expect(roundAwareValue({ blend, src, round })).toBeCloseTo((1 - t) * early + t * late);
    const vals = [6, 7, 8, 9, 10].map((round) => roundAwareValue({ blend, src, round }));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
  });
  it("no evidence (missing source) leaves the value alone", () => {
    expect(roundAwareValue({ blend, src: undefined, round: 2 })).toBe(blend);
    expect(roundAwareValue({ blend, src: undefined, round: 12 })).toBe(blend);
  });
});

const line = (o: Partial<ProjectionLine> = {}): ProjectionLine => ({
  games: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, ...o,
});
function rec(id: string, yahoo: ProjectionLine | null, actual: ProjectionLine | null, rank = 50): PlayerRecord {
  const base = makeRecord({ id, market: { rank, yahooAdp: rank } });
  const cur = yahoo ?? actual ?? line();
  return {
    ...base,
    projection: { ...base.projection, ...cur, playerId: id, projectionSource: yahoo ? "yahoo-2026-27" : "nba-stats",
      components: { yahoo, actual, projection: yahoo, evidence: { age: 27, team26: "TST", team25: "TST", team24: "TST", fromYear: 2015 } } },
  };
}

describe("sourceZ + scorePlayers (auto robustness)", () => {
  /** A consistent player and a volatile one whose blended value is identical at a 50/50 mix. */
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

  it("sourceZ skips players with one source or few real games", () => {
    const s = sourceZ([...universe(), rec("rk", line(), null, 90), rec("lowgp", line(), line({ games: 10 }), 91)]);
    expect(s.rk).toBeUndefined();
    expect(s.lowgp).toBeUndefined();
    expect(lineDistance(s.volatile)).toBeGreaterThan(lineDistance(s.consistent) * 2);
  });

  const run = (currentPick: number, strategy = makeStrategy("balanced"), withSources = true) => {
    const raw = universe();
    const blended = applyProjectionBlend(raw, 0.5);
    const out = scorePlayers({
      records: blended, valuations: computeValuations(blended).valuations, draftedIds: [], userRosterIds: [], currentPick, userNextPick: currentPick, isUserOnClock: true,
      survival: null, now: 0, strategy, sources: withSources ? sourceZ(raw) : undefined,
    });
    const get = (id: string) => out.find((x) => x.playerId === id)!;
    return { a: get("consistent"), b: get("volatile") };
  };

  it("early rounds: the consistent player outranks the volatile one at equal blended value", () => {
    const { a, b } = run(5); // round 1 in a 14-team league
    expect(a.draftScore).toBeGreaterThan(b.draftScore + 0.5);
  });
  it("late rounds: the upside flips it", () => {
    const { a, b } = run(14 * 11 + 3); // round 12
    expect(b.draftScore).toBeGreaterThan(a.draftScore);
  });
  it("mode never: no adjustment in any round; no sources supplied: nothing to adjust", () => {
    const never = makeStrategy("balanced", undefined, undefined, { robustnessMode: "never" });
    for (const pick of [5, 14 * 11 + 3]) {
      const { a, b } = run(pick, never);
      expect(a.draftScore).toBeCloseTo(b.draftScore, 6);
    }
    const { a, b } = run(5, makeStrategy("balanced"), false);
    expect(a.draftScore).toBeCloseTo(b.draftScore, 6);
  });
  it("mode always: lambda * d in every round, like the old checkbox", () => {
    const always = makeStrategy("balanced", undefined, undefined, { robustnessMode: "always" });
    for (const pick of [5, 14 * 11 + 3]) {
      const { a, b } = run(pick, always);
      expect(a.draftScore).toBeGreaterThan(b.draftScore + 0.2);
    }
  });
});
