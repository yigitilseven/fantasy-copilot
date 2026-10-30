import { describe, expect, it } from "vitest";
import {
  GROUPS, calibrate, formatBacktest, kappaForAnchor, ols, pairSeasons, per36Line, production, rmse, runBacktest, yahooWeight, type SeasonRow,
} from "@/engine/projection/backtest";
import type { ProjectionLine } from "@/types";

const line = (o: Partial<ProjectionLine> = {}): ProjectionLine => ({
  games: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, ...o,
});
const row = (id: string, o: Partial<ProjectionLine> = {}, team: string | null = "AAA", age: number | null = 27): SeasonRow => ({ id, name: id, team, age, line: line(o) });

/** Deterministic pseudo-random in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("statistics helpers", () => {
  it("ols recovers a line and r2 = 1 for exact data; rmse", () => {
    const f = ols([1, 2, 3, 4], [3, 5, 7, 9]);
    expect(f.a).toBeCloseTo(1);
    expect(f.b).toBeCloseTo(2);
    expect(f.r2).toBeCloseTo(1);
    expect(rmse([1, 2, 3], [1, 2, 5])).toBeCloseTo(Math.sqrt(4 / 3));
    expect(ols([1, 2], [1, 2]).r2).toBe(0); // too few points: no claim
  });
  it("per36Line scales rates to 36 minutes; production uses the NBA fantasy-points formula", () => {
    expect(per36Line(line({ minutes: 18, pts: 9 })).pts).toBeCloseTo(18);
    expect(per36Line(line({ minutes: 18, pts: 9 })).minutes).toBe(36);
    expect(production(line({ pts: 10, reb: 5, ast: 2, stl: 1, blk: 1, tov: 2 }))).toBeCloseTo(10 + 6 + 3 + 3 + 3 - 2);
  });
});

describe("pairSeasons", () => {
  it("keeps players with >= minGp games in both seasons, drops duplicated ids", () => {
    const prev = [row("a"), row("b", { games: 19 }), row("c"), row("dup"), row("dup")];
    const next = [row("a"), row("b"), row("c", { games: 5 }), row("dup"), row("new")];
    expect(pairSeasons(prev, next, 20).map((p) => p.id)).toEqual(["a"]);
    expect(pairSeasons(prev, next, 5).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("runBacktest on synthetic fixtures", () => {
  /** 200 players: next season = previous season (perfect persistence) except for a noisy group. */
  function seasons(noise: (i: number) => number) {
    const r = rng(7);
    const prev: SeasonRow[] = [];
    const next: SeasonRow[] = [];
    for (let i = 0; i < 200; i++) {
      const q = r();
      const base = { games: 60 + Math.round(r() * 20), minutes: 20 + 14 * q, pts: 6 + 20 * q, reb: 2 + 8 * r(), ast: 1 + 6 * r(), threePm: 0.3 + 2.5 * r(), stl: 0.4 + 1.2 * r(), blk: 0.2 + 1.5 * r(), tov: 0.8 + 2 * r() };
      const fga = base.pts * 0.8;
      const mk = (jit: number) => line({ ...base, pts: base.pts * (1 + jit), fga: fga * (1 + jit), fgm: fga * 0.46 * (1 + jit), fta: base.pts * 0.25, ftm: base.pts * 0.2 });
      const age = 20 + (i % 16);
      prev.push({ id: `p${i}`, name: `p${i}`, team: "AAA", age, line: mk(0) });
      next.push({ id: `p${i}`, name: `p${i}`, team: i % 5 === 0 ? "BBB" : "AAA", age: age + 1, line: mk(noise(i)) });
    }
    return { prev, next };
  }

  it("perfect persistence: R^2 = 1 for rates and volume, zero naive error", () => {
    const { prev, next } = seasons(() => 0);
    const res = runBacktest(prev, next);
    const all = res.groups.find((g) => g.id === "all")!;
    expect(res.pairs).toBe(200);
    expect(all.n).toBe(200);
    expect(all.rateR2).toBeGreaterThan(0.97);
    expect(all.volR2).toBeGreaterThan(0.97);
    expect(all.rmseSumZ36).toBeLessThan(0.05);
  });

  it("a noisy group has a lower R^2, a higher error and therefore a higher Yahoo weight", () => {
    const r = rng(99);
    const { prev, next } = seasons((i) => (i % 5 === 0 ? (r() - 0.5) * 1.2 : 0)); // team changers (i % 5 === 0) are noisy
    const res = runBacktest(prev, next);
    const g = (id: string) => res.groups.find((x) => x.id === id)!;
    expect(g("team").n).toBe(40);
    expect(g("team").rateR2).toBeLessThan(g("stable").rateR2);
    expect(g("team").rateRelMse).toBeGreaterThan(g("all").rateRelMse);
    const w = new Map(calibrate(res, { kappa: kappaForAnchor(0.6), min: 0.3, max: 0.9 }).map((x) => [x.id, x]));
    expect(w.get("team")!.wRate).toBeGreaterThan(w.get("all")!.wRate);
    expect(w.get("all")!.wRate).toBeCloseTo(0.6, 6); // anchored
    expect(w.get("stable")!.wRate).toBeLessThan(w.get("all")!.wRate);
  });

  it("group tests mirror the production predicates", () => {
    const find = (id: string) => GROUPS.find((g) => g.id === id)!;
    const pair = (age: number, prevGp: number, t0: string, t1: string) => ({ id: "x", name: "x", prev: row("x", { games: prevGp }, t0, age - 1), next: row("x", {}, t1, age) });
    expect(find("young").test(pair(23, 70, "A", "A"))).toBe(true);
    expect(find("young").test(pair(24, 70, "A", "A"))).toBe(false);
    expect(find("stable").test(pair(27, 65, "A", "A"))).toBe(true);
    expect(find("stable").test(pair(27, 65, "A", "B"))).toBe(false);
    expect(find("stable").test(pair(27, 55, "A", "A"))).toBe(false);
    expect(find("age32").test(pair(32, 70, "A", "A"))).toBe(true);
    expect(find("team").test(pair(27, 70, "A", "B"))).toBe(true);
    expect(find("injury").test(pair(27, 39, "A", "A"))).toBe(true);
    expect(find("injury").test(pair(27, 40, "A", "A"))).toBe(false);
  });

  it("minutes elasticity: all production change via minutes -> ~1; none -> ~0", () => {
    const r = rng(3);
    const prev: SeasonRow[] = [];
    const viaMinutes: SeasonRow[] = [];
    const viaRate: SeasonRow[] = [];
    for (let i = 0; i < 120; i++) {
      const k = 0.7 + 0.8 * r();
      const l = line({ minutes: 20 + 10 * r(), pts: 10 + 10 * r() });
      prev.push({ id: `p${i}`, name: "", team: "A", age: 27, line: l });
      // production scales by k through minutes (per-36 rates constant) ...
      viaMinutes.push({ id: `p${i}`, name: "", team: "A", age: 28, line: { ...l, minutes: l.minutes * k, pts: l.pts * k, reb: l.reb * k, ast: l.ast * k, stl: l.stl * k, blk: l.blk * k, tov: l.tov * k } });
      // ... or through rates at constant minutes
      viaRate.push({ id: `p${i}`, name: "", team: "A", age: 28, line: { ...l, pts: l.pts * k, reb: l.reb * k, ast: l.ast * k, stl: l.stl * k, blk: l.blk * k, tov: l.tov * k } });
    }
    expect(runBacktest(prev, viaMinutes).minutesElasticity).toBeGreaterThan(0.95);
    expect(Math.abs(runBacktest(prev, viaRate).minutesElasticity)).toBeLessThan(0.05);
  });
});

describe("calibration formula", () => {
  it("inverse-variance weight: pooled error -> anchor; double error -> lower trust; clamped", () => {
    const o = { kappa: kappaForAnchor(0.6), min: 0.3, max: 0.9 };
    expect(kappaForAnchor(0.6)).toBeCloseTo(2 / 3);
    expect(yahooWeight(0.4, 0.4, o)).toBeCloseTo(0.6);
    expect(yahooWeight(0.8, 0.4, o)).toBeGreaterThan(0.6);
    expect(yahooWeight(0.2, 0.4, o)).toBeLessThan(0.6);
    expect(yahooWeight(1e9, 0.4, o)).toBe(0.9);
    expect(yahooWeight(1e-9, 0.4, o)).toBe(0.3);
  });
  it("formatBacktest prints a row per group", () => {
    const { prev, next } = (() => {
      const prev: SeasonRow[] = [];
      const next: SeasonRow[] = [];
      for (let i = 0; i < 60; i++) {
        prev.push(row(`p${i}`, { pts: 8 + i / 3, reb: 3 + (i % 7) }));
        next.push(row(`p${i}`, { pts: 8 + i / 3.2, reb: 3 + (i % 5) }));
      }
      return { prev, next };
    })();
    const txt = formatBacktest(runBacktest(prev, next), { kappa: 0.667, min: 0.3, max: 0.9 });
    for (const g of GROUPS) expect(txt).toContain(g.label.slice(0, 20));
  });
});
