import { describe, it, expect } from "vitest";
import { simulateSurvival } from "@/engine/draft/simulator";
import { survivalToNextPick, buildSurvivalInput, buildSimPlayers } from "@/engine/draft/survival";
import { createRng } from "@/engine/draft/rng";
import type { SimPlayer, SimulationInput } from "@/types";

function mkPlayers(n: number): SimPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, adp: i + 1, adpStdDev: 2 + i * 0.1, value: 10 - i * 0.05, positions: ["PG"],
  }));
}
const base = (over: Partial<SimulationInput> = {}): SimulationInput => ({
  currentPick: 1, targetPick: 13, teams: 12, players: mkPlayers(200),
  simulations: 5000, seed: 42, ...over,
});

describe("rng", () => {
  it("deterministic and sane", () => {
    const a = createRng(7), b = createRng(7);
    for (let i = 0; i < 50; i++) expect(a.normal()).toBe(b.normal());
    const r = createRng(1);
    let s = 0, s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) { const x = r.normal(); s += x; s2 += x * x; }
    expect(Math.abs(s / n)).toBeLessThan(0.05);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.05);
  });
});

describe("simulateSurvival", () => {
  it("is deterministic", () => {
    const a = simulateSurvival(base()), b = simulateSurvival(base());
    expect(a.survival).toEqual(b.survival);
    const c = simulateSurvival(base({ seed: 43 }));
    expect(c.survival).not.toEqual(a.survival);
  });
  it("survival in [0,1], extremes", () => {
    const r = simulateSurvival(base());
    for (const v of Object.values(r.survival)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(Object.keys(r.survival)).toHaveLength(200);
    expect(r.survival.p1).toBeLessThan(0.02);
    expect(r.survival.p150).toBe(1);
    expect(r.picksSimulated).toBe(12);
  });
  it("roughly monotonic in ADP", () => {
    const r = simulateSurvival(base());
    for (let i = 1; i < 30; i++) expect(r.survival[`p${i + 1}`]).toBeGreaterThanOrEqual(r.survival[`p${i}`] - 0.05);
  });
  it("sum of non-survival equals picks simulated", () => {
    const r = simulateSurvival(base());
    const taken = Object.values(r.survival).reduce((a, v) => a + (1 - v), 0);
    expect(taken).toBeCloseTo(12, 6);
  });
  it("targetPick <= currentPick → all 1", () => {
    for (const t of [10, 5]) {
      const r = simulateSurvival(base({ currentPick: 10, targetPick: t }));
      expect(Object.values(r.survival).every((v) => v === 1)).toBe(true);
      expect(r.picksSimulated).toBe(0);
    }
  });
  it("skipPicks reduces picks simulated", () => {
    const full = simulateSurvival(base());
    const skip = simulateSurvival(base({ skipPicks: [3, 7] }));
    expect(skip.picksSimulated).toBe(10);
    expect(skip.survival.p1).toBeGreaterThan(full.survival.p1 - 1e-9);
    const t = Object.values(skip.survival).reduce((a, v) => a + (1 - v), 0);
    expect(t).toBeCloseTo(10, 6);
  });
});

describe("survivalToNextPick", () => {
  const players = buildSimPlayers(mkPlayers(200));
  it("target after current when on the clock, skipping nothing extra", () => {
    const r = survivalToNextPick({ currentPick: 13, teams: 14, userSlot: 13, rounds: 13, players, simulations: 1000, seed: 1 })!;
    expect(r.targetPick).toBe(16);
    expect(r.result.picksSimulated).toBe(2); // picks 14,15 + own pick 13 skipped
  });
  it("target is next user pick when not on the clock", () => {
    const r = survivalToNextPick({ currentPick: 5, teams: 14, userSlot: 13, rounds: 13, players, simulations: 1000, seed: 1 })!;
    expect(r.targetPick).toBe(13);
    expect(r.result.picksSimulated).toBe(8);
  });
  it("null when no future pick", () => {
    expect(survivalToNextPick({ currentPick: 181, teams: 14, userSlot: 13, rounds: 13, players, simulations: 10, seed: 1 })).toBeNull();
    expect(survivalToNextPick({ currentPick: 170, teams: 14, userSlot: 13, rounds: 13, players, simulations: 10, seed: 1 })!.targetPick).toBe(181);
  });
});

describe("buildSurvivalInput", () => {
  const players = buildSimPlayers(mkPlayers(50));
  const a = { teams: 14, userSlot: 13, rounds: 13, players, simulations: 100, seed: 9 };
  it("on the clock: target is next user pick after, own pick skipped", () => {
    const r = buildSurvivalInput({ ...a, currentPick: 13 })!;
    expect(r.targetPick).toBe(16);
    expect(r.input).toMatchObject({ currentPick: 13, targetPick: 16, seed: 9, simulations: 100, skipPicks: [13] });
  });
  it("not on the clock: no skips", () => {
    const r = buildSurvivalInput({ ...a, currentPick: 14 })!;
    expect(r.targetPick).toBe(16);
    expect(r.input.skipPicks).toEqual([]);
  });
  it("null when no future pick", () => {
    expect(buildSurvivalInput({ ...a, currentPick: 181 })).toBeNull();
  });
});
