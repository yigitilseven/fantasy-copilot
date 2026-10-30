import { it, expect } from "vitest";
import { simulateSurvival } from "@/engine/draft/simulator";
import type { SimPlayer } from "@/types";

it("25k sims x 200 players x 25 picks is fast", () => {
  const players: SimPlayer[] = Array.from({ length: 200 }, (_, i) => ({
    id: `p${i}`, adp: i + 1, adpStdDev: 3 + i * 0.05, value: 10 - i * 0.04, positions: ["C"],
  }));
  const input = { currentPick: 1, targetPick: 26, teams: 12, players, simulations: 25000, seed: 1 };
  simulateSurvival({ ...input, simulations: 500 }); // warm up
  const t0 = performance.now();
  const r = simulateSurvival(input);
  const ms = performance.now() - t0;
  console.log(`25k sims x 200 players x 25 picks: ${ms.toFixed(1)}ms (reported ${r.elapsedMs.toFixed(1)}ms)`);
  expect(r.picksSimulated).toBe(25);
  expect(ms).toBeLessThan(1500);
});
