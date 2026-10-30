import type { CategoryScores, PlayerValuation } from "@/types";
import { CATEGORIES } from "@/types";

/** Roster-dependent value: sum of z_c * need weight_c. */
export function rosterFitValue(valuation: PlayerValuation, weights: CategoryScores): number {
  let s = 0;
  for (const c of CATEGORIES) s += valuation.z[c] * weights[c];
  return s;
}
