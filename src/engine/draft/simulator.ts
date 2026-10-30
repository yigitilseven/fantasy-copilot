import type { SimulationInput, SimulationResult } from "@/types";
import { createRng } from "./rng";

/**
 * Monte Carlo survival simulator (spec 12/13).
 *
 * Opponent model (V1): per simulation each candidate player gets one sampled
 * "draft position" = adp + adpStdDev * N(0,1) (ADP as a distribution, so reaches
 * and falls happen). Every simulated opponent pick takes the available player with
 * the lowest sampled key, where key = position - VALUE_EPS * value (mild value
 * tiebreak). Positional need is ignored in V1; randomness comes from the ADP noise.
 *
 * Performance: players sorted by ADP once; only the top K (= picks + BUFFER, plus
 * anyone whose adp - 3sd could reach the target) are candidates; others survive
 * with probability 1. Typed arrays, repeated min-scan (partial selection), no
 * allocations in the hot loop.
 */
const BUFFER = 60;
const VALUE_EPS = 0.01;

export function simulateSurvival(input: SimulationInput): SimulationResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { currentPick, targetPick, players, simulations } = input;
  const skip = new Set(input.skipPicks ?? []);

  let picks = 0;
  for (let p = currentPick; p < targetPick; p++) if (!skip.has(p)) picks++;

  const survival: Record<string, number> = {};
  const finish = (): SimulationResult => ({
    survival,
    simulations,
    picksSimulated: picks,
    elapsedMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
  });

  if (picks === 0 || simulations <= 0 || players.length === 0) {
    for (const p of players) survival[p.id] = 1;
    return finish();
  }

  const kMul = input.model && input.model.k > 0 ? input.model.k : 1;
  const autoShare = input.model ? Math.min(1, Math.max(0, input.model.autopickShare)) : 0;
  const order = players.slice().sort((a, b) => a.adp - b.adp);
  const cand: typeof players = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    if (i < picks + BUFFER || p.adp - 3 * kMul * p.adpStdDev <= targetPick) cand.push(p);
    else survival[p.id] = 1;
  }
  const k = cand.length;
  const take = Math.min(picks, k);
  const adp = new Float64Array(k);
  const sd = new Float64Array(k);
  const val = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    adp[i] = cand[i].adp;
    sd[i] = cand[i].adpStdDev * kMul;
    val[i] = cand[i].value * VALUE_EPS;
  }
  const key = new Float64Array(k);
  const taken = new Uint32Array(k);
  const rng = createRng(input.seed);

  for (let s = 0; s < simulations; s++) {
    for (let i = 0; i < k; i++) key[i] = adp[i] + sd[i] * rng.normal() - val[i];
    let adpPtr = 0; // cand is sorted by ADP: the first not-yet-taken index is the "autopick" choice
    for (let n = 0; n < take; n++) {
      let best = 0;
      if (autoShare > 0 && rng.next() < autoShare) {
        while (adpPtr < k && key[adpPtr] === Infinity) adpPtr++;
        best = adpPtr < k ? adpPtr : 0;
      } else {
        let bestKey = Infinity;
        for (let i = 0; i < k; i++) {
          const v = key[i];
          if (v < bestKey) {
            bestKey = v;
            best = i;
          }
        }
      }
      key[best] = Infinity; // removed
      taken[best]++;
    }
  }
  for (let i = 0; i < k; i++) survival[cand[i].id] = 1 - taken[i] / simulations;
  return finish();
}
