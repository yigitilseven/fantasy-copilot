import { describe, expect, it } from "vitest";
import type { PlayerRecord } from "@/types";
import { TO_EMPHASIS, computeValuations } from "@/engine/valuation/value";
import { objectiveModeOf, valuationOptionsOf, makeStrategy, applyStrategyPatch, defaultStrategy, parseStrategy, strategyKey } from "@/engine/recommendation/strategy";
import { makeRecord } from "./fixtures";

/** A league-like pool where turnovers grow with scoring + passing volume, plus the two archetypes. */
function pool(): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  for (let i = 0; i < 200; i++) {
    const q = 1 - i / 200;
    const pts = 8 + 18 * q;
    const ast = 1.2 + 6 * q * ((i * 7) % 5 < 2 ? 1.3 : 0.4);
    out.push(
      makeRecord({
        id: `f${i}`,
        projection: { pts, ast, fga: 5 + 0.45 * pts, fgm: (5 + 0.45 * pts) * (0.46 + 0.09 * Math.sin(i * 1.3)), fta: 1 + 0.12 * pts, ftm: (1 + 0.12 * pts) * (0.76 + 0.14 * Math.sin(i * 0.7)), reb: 3 + 5 * ((i * 3) % 7) / 7, tov: 0.4 + 0.075 * (pts + ast) + 0.45 * Math.sin(i), threePm: 0.3 + 0.1 * pts * (0.6 + 0.4 * Math.sin(i * 0.9)), stl: 0.5 + 0.3 * (1 + Math.sin(i * 2.1)), blk: 0.3 + 0.4 * (1 + Math.sin(i * 1.7)) },
        market: { yahooAdp: 5 + i * 1.2, rank: 5 + i },
      }),
    );
  }
  out.push(
    // high-usage efficient guard: lots of PTS/AST, many turnovers for his volume but normal for it
    makeRecord({ id: "guard", projection: { pts: 23, fgm: 8.2, fga: 17, ftm: 4.6, fta: 5.6, threePm: 2.4, reb: 4, ast: 6.5, stl: 1.0, blk: 0.3, tov: 3.1 }, market: { yahooAdp: 12, rank: 12 } }),
    // low-usage big: tiny PTS/AST, hardly ever turns it over, rebounds + blocks
    makeRecord({ id: "big", projection: { pts: 13, fgm: 5.2, fga: 9.5, ftm: 2.2, fta: 3.2, threePm: 0.1, reb: 10, ast: 1.8, stl: 0.8, blk: 1.5, tov: 1.2 }, market: { yahooAdp: 40, rank: 40 } }),
  );
  return out;
}

describe("usage-neutral turnovers", () => {
  const recs = pool();
  const plain = computeValuations(recs).valuations;
  const adj = computeValuations(recs, { usageAdjustTO: true }).valuations;

  it("plain TO z rewards the low-usage big and punishes the guard heavily", () => {
    expect(plain.big.z.TO).toBeGreaterThan(plain.guard.z.TO + 1.5);
  });
  it("the residual TO z removes most of that usage effect and applies the 0.6 emphasis", () => {
    const gapPlain = plain.big.z.TO - plain.guard.z.TO;
    const gapAdj = adj.big.z.TO - adj.guard.z.TO;
    expect(gapAdj).toBeLessThan(gapPlain * 0.5);
    expect(TO_EMPHASIS).toBe(0.6);
    // emphasis scales the adjusted z linearly
    const half = computeValuations(recs, { usageAdjustTO: true, toEmphasis: 0.3 }).valuations;
    expect(half.guard.z.TO).toBeCloseTo(adj.guard.z.TO / 2, 9);
  });
  it("a high-usage efficient guard is no longer outranked by a low-usage big on TO alone", () => {
    // Without the correction the big's 9-cat sum beats the guard's only thanks to TO; with it the guard leads.
    const plainNoTo = (v: typeof plain.big) => v.nineCat - v.z.TO;
    expect(plainNoTo(plain.guard)).toBeGreaterThan(plainNoTo(plain.big)); // the guard is the better player apart from TO
    expect(plain.big.nineCat).toBeGreaterThan(plain.guard.nineCat); // ...but plain z-sum ranks the big higher
    expect(adj.guard.nineCat).toBeGreaterThan(adj.big.nineCat); // corrected: the guard leads
  });
  it("is a no-op unless asked for, and the z of other categories is unchanged", () => {
    for (const k of ["PTS", "REB", "AST", "FG%", "FT%"] as const) expect(adj.guard.z[k]).toBeCloseTo(plain.guard.z[k], 12);
    expect(computeValuations(recs, {}).valuations.guard.z.TO).toBe(plain.guard.z.TO);
  });
});

describe("objective setting on the strategy", () => {
  it("defaults to h2h, round-trips through patch / parse / key, and classic switches the z correction off", () => {
    expect(objectiveModeOf(defaultStrategy())).toBe("h2h");
    expect(defaultStrategy().objective).toBeUndefined(); // default is not stored (older drafts parse identically)
    const s = applyStrategyPatch(defaultStrategy(), { objective: "robust" });
    expect(s.objective).toBe("robust");
    expect(parseStrategy(JSON.stringify(s)).objective).toBe("robust");
    expect(strategyKey(s)).not.toBe(strategyKey(defaultStrategy()));
    expect(applyStrategyPatch(s, { preset: "punt-ft" }).objective).toBe("robust"); // independent of the preset
    expect(applyStrategyPatch(s, { objective: "h2h" }).objective).toBeUndefined();
    expect(parseStrategy({ objective: "nonsense" })).toEqual(defaultStrategy());
    expect(valuationOptionsOf(makeStrategy("balanced", undefined, undefined, { objective: "classic" }))).toEqual({});
    expect(valuationOptionsOf(defaultStrategy())).toEqual({ usageAdjustTO: true, toEmphasis: 0.6 });
  });
});
