import { describe, it, expect } from "vitest";
import { fgImpact, ftImpact, leagueRates } from "@/engine/valuation/percentages";
import { mean, stdDev, zScore } from "@/engine/valuation/zscore";
import { computeValuations } from "@/engine/valuation/value";
import { makeRecord } from "./fixtures";

describe("percentages", () => {
  const a = makeRecord({ id: "a", projection: { fgm: 8, fga: 16, ftm: 4, fta: 5 } });
  const b = makeRecord({ id: "b", projection: { fgm: 2, fga: 4, ftm: 1, fta: 5 } });
  it("league rates are volume weighted", () => {
    const r = leagueRates([a.projection, b.projection]);
    expect(r.fgPct).toBeCloseTo(10 / 20);
    expect(r.ftPct).toBeCloseTo(5 / 10);
  });
  it("impacts match hand computation", () => {
    // a: (0.5 - 0.45)*16 = 0.8 ; ft (0.8 - 0.5)*5 = 1.5
    expect(fgImpact(a.projection, 0.45)).toBeCloseTo(0.8);
    expect(ftImpact(a.projection, 0.5)).toBeCloseTo(1.5);
    // b: fg (0.5-0.45)*4 = 0.2 ; ft (0.2-0.5)*5 = -1.5
    expect(fgImpact(b.projection, 0.45)).toBeCloseTo(0.2);
    expect(ftImpact(b.projection, 0.5)).toBeCloseTo(-1.5);
  });
  it("zero attempts gives zero impact", () => {
    expect(fgImpact({ fgm: 0, fga: 0, ftm: 0, fta: 0 }, 0.45)).toBe(0);
    expect(ftImpact({ fgm: 0, fga: 0, ftm: 0, fta: 0 }, 0.8)).toBe(0);
  });
});

describe("zscore helpers", () => {
  it("population stats", () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    expect(stdDev(xs)).toBe(2);
    expect(zScore(9, 5, 2)).toBe(2);
    expect(zScore(3, 5, 0)).toBe(0);
  });
});

describe("computeValuations", () => {
  const recs = [
    makeRecord({ id: "a", market: { rank: 1 }, projection: { pts: 10, tov: 1 } }),
    makeRecord({ id: "b", market: { rank: 2 }, projection: { pts: 20, tov: 3 } }),
    makeRecord({ id: "c", market: { rank: 3 }, projection: { pts: 30, tov: 2 } }),
  ];
  it("fixed population gives fixed z-scores; TO inverted", () => {
    const { valuations, context } = computeValuations(recs);
    const sd = Math.sqrt(200 / 3);
    expect(context.means.PTS).toBeCloseTo(20);
    expect(valuations.a.z.PTS).toBeCloseTo(-10 / sd);
    expect(valuations.c.z.PTS).toBeCloseTo(10 / sd);
    // TO: mean 2, sd sqrt(2/3); a has fewer turnovers -> positive
    expect(valuations.a.z.TO).toBeCloseTo(1 / Math.sqrt(2 / 3));
    expect(valuations.b.z.TO).toBeLessThan(0);
    expect(valuations.c.z.TO).toBeCloseTo(0);
  });
  it("zero variance categories give z 0 and nineCat is the sum", () => {
    const { valuations } = computeValuations(recs);
    expect(valuations.a.z.REB).toBe(0);
    const v = valuations.b;
    const sum = Object.values(v.z).reduce((x, y) => x + y, 0);
    expect(v.nineCat).toBeCloseTo(sum);
  });
  it("pool limits stats population but all records are valued", () => {
    const { valuations, context } = computeValuations(recs, { poolSize: 2 });
    expect(context.poolIds).toEqual(["a", "b"]);
    expect(context.means.PTS).toBeCloseTo(15);
    expect(valuations.c).toBeDefined();
    expect(valuations.c.z.PTS).toBeCloseTo(15 / 5);
  });
  it("percentage categories reward volume", () => {
    const hi = makeRecord({ id: "hi", market: { rank: 1 }, projection: { fgm: 10, fga: 16 } });
    const lo = makeRecord({ id: "lo", market: { rank: 2 }, projection: { fgm: 3, fga: 8 } });
    const { valuations } = computeValuations([hi, lo]);
    expect(valuations.hi.z["FG%"]).toBeGreaterThan(0);
    expect(valuations.lo.z["FG%"]).toBeLessThan(0);
  });
});
