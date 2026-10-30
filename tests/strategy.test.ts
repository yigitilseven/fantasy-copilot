import { describe, expect, it } from "vitest";
import type { PlayerRecord } from "@/types";
import { CATEGORIES } from "@/types";
import { computeValuations } from "@/engine/valuation/value";
import { scorePlayers, type RecommendInput } from "@/engine/recommendation/score";
import {
  applyStrategyPatch, defaultStrategy, makeStrategy, parseStrategy, puntedCategories, RISK_PRESETS, strategyKey,
} from "@/engine/recommendation/strategy";
import { makeRecord } from "./fixtures";

function universe(n = 220): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  for (let i = 0; i < n; i++) {
    const q = 1 - i / n;
    const k = i % 5;
    out.push(
      makeRecord({
        id: `u${i}`,
        positions: [(["PG", "SG", "SF", "PF", "C"] as const)[k]],
        projection: {
          pts: 8 + 18 * q + (k % 2), threePm: 0.5 + 2 * q * (k < 2 ? 1.3 : 0.4), reb: 3 + 8 * q * (k > 2 ? 1.4 : 0.5),
          ast: 1.5 + 6 * q * (k < 2 ? 1.4 : 0.4), stl: 0.5 + q, blk: 0.2 + 1.2 * q * (k > 2 ? 1.5 : 0.3), tov: 1 + 2 * q,
        },
        market: { yahooAdp: i + 1, rank: i + 1 },
      }),
    );
  }
  // Giannis-like: elite everything except free throws (and no threes).
  out.push(
    makeRecord({
      id: "giannis", name: "Giannis-like", positions: ["PF"],
      projection: { pts: 30, fgm: 11.5, fga: 18.5, ftm: 6.2, fta: 11, threePm: 0.5, reb: 11.5, ast: 6, stl: 1.2, blk: 1.1, tov: 3.4 },
      market: { yahooAdp: 6, rank: 6 },
    }),
  );
  return out;
}

function input(records: PlayerRecord[], over: Partial<RecommendInput> = {}): RecommendInput {
  const { valuations } = computeValuations(records);
  return { records, valuations, draftedIds: [], userRosterIds: [], currentPick: 1, userNextPick: 28, isUserOnClock: false, survival: null, ...over };
}

describe("strategy helpers", () => {
  it("presets and patches", () => {
    expect(puntedCategories(makeStrategy("punt-ft"))).toEqual(["FT%"]);
    expect(makeStrategy("punt-ft").categoryEmphasis).toMatchObject({ "FT%": 0, "FG%": 1.15, REB: 1.1, BLK: 1.1, PTS: 1 });
    expect(makeStrategy("punt-ast").categoryEmphasis.TO).toBe(0.7);
    expect(defaultStrategy().riskTolerance).toBe(RISK_PRESETS.conservative);
    const s = applyStrategyPatch(defaultStrategy(), { preset: "punt-to", riskTolerance: 0.05 });
    expect(s).toMatchObject({ preset: "punt-to", riskTolerance: 0.05 });
    // emphasis only -> custom, other cats keep multipliers; a non-custom preset resets it
    const c = applyStrategyPatch(s, { categoryEmphasis: { BLK: 2 } });
    expect(c.preset).toBe("custom");
    expect(c.categoryEmphasis.BLK).toBe(2);
    expect(c.categoryEmphasis.TO).toBe(0);
    expect(applyStrategyPatch(c, { preset: "balanced" }).categoryEmphasis).toEqual(defaultStrategy().categoryEmphasis);
    expect(strategyKey(parseStrategy(JSON.stringify(c)))).toBe(strategyKey(c));
    expect(parseStrategy("garbage")).toEqual(defaultStrategy());
    expect(parseStrategy(null)).toEqual(defaultStrategy());
  });
});

describe("scorePlayers with a strategy", () => {
  const recs = universe();

  it("default / balanced+conservative strategy gives identical results to no strategy", () => {
    const base = scorePlayers(input(recs));
    const withBalanced = scorePlayers(input(recs, { strategy: defaultStrategy() }));
    expect(withBalanced).toEqual(base);
  });

  it("punt-FT ranks a Giannis-like player higher than balanced", () => {
    const rank = (inp: RecommendInput) => scorePlayers(inp).findIndex((s) => s.playerId === "giannis");
    const balanced = rank(input(recs));
    const punt = rank(input(recs, { strategy: makeStrategy("punt-ft") }));
    expect(punt).toBeLessThan(balanced);
    const sb = scorePlayers(input(recs)).find((s) => s.playerId === "giannis")!;
    const sp = scorePlayers(input(recs, { strategy: makeStrategy("punt-ft") })).find((s) => s.playerId === "giannis")!;
    expect(sp.nineCat).toBeGreaterThan(sb.nineCat);
    expect(sp.riskAdjusted).toBeGreaterThan(sb.riskAdjusted);
    expect(sp.reason).toMatch(/punt-FT build/);
  });

  it("a punted category never appears among the top needs / reasons, even with a roster weak in it", () => {
    // roster of poor free-throw shooters -> FT% would be the top need in a balanced build
    const poor = ["giannis", ...recs.slice(100, 104).map((r) => r.player.id)];
    const noPunt = scorePlayers(input(recs, { userRosterIds: poor, draftedIds: poor }));
    expect(noPunt[0].reason).not.toMatch(/punt/);
    const punt = scorePlayers(input(recs, { userRosterIds: poor, draftedIds: poor, strategy: makeStrategy("punt-ft") }));
    for (const s of punt) expect(s.reason).not.toMatch(/Helps your needs in[^.]*FT%/);
  });

  it("riskTolerance from the strategy overrides config", () => {
    const risky = recs.map((r) => (r.player.id === "u0" ? { ...r, risk: { ...r.risk, currentStatus: "out" as const, injuryHistoryScore: 0.8, majorInjuryHistory: true } } : r));
    const a = scorePlayers(input(risky, { strategy: makeStrategy("balanced", 0.05) })).find((s) => s.playerId === "u0")!;
    const b = scorePlayers(input(risky, { strategy: makeStrategy("balanced", 0.3) })).find((s) => s.playerId === "u0")!;
    expect(a.riskPenalty).toBeLessThanOrEqual(b.riskPenalty);
    expect(b.riskPenalty).toBeGreaterThan(0);
  });

  it("every preset only zeroes its own category", () => {
    for (const p of ["punt-ft", "punt-fg", "punt-to", "punt-ast", "punt-3pm", "punt-pts"] as const) {
      expect(puntedCategories(makeStrategy(p))).toHaveLength(1);
      expect(CATEGORIES.filter((c) => makeStrategy(p).categoryEmphasis[c] === 0)).toHaveLength(1);
    }
  });
});
