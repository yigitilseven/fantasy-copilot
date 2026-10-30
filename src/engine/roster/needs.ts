import type { CategoryScores, PlayerValuation } from "@/types";
import { CATEGORIES } from "@/types";
import { leagueConfig } from "@/config/default-league";

/** Sensitivity of need weight to the roster's per-player average z in a category. */
export const NEED_K = 0.35;

function zeros(): CategoryScores {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as CategoryScores;
}

/** Sum of per-category z-scores across rostered players. */
export function categoryProfile(
  rosterIds: string[],
  valuations: Record<string, PlayerValuation>,
): CategoryScores {
  const out = zeros();
  for (const id of rosterIds) {
    const v = valuations[id];
    if (!v) continue;
    for (const c of CATEGORIES) out[c] += v.z[c];
  }
  return out;
}

/**
 * weight = clamp(1 - k * avgZ, min, max); weak categories > 1, strong < 1. Empty roster → 1.
 * Categories punted by the strategy (emphasis <= 0) are ignored: weight 0.
 */
export function needWeights(
  profile: CategoryScores,
  rosterSize: number,
  bounds: { min: number; max: number } = leagueConfig.needWeightBounds,
  emphasis?: CategoryScores,
): CategoryScores {
  const out = zeros();
  for (const c of CATEGORIES) {
    if (emphasis && emphasis[c] <= 0) continue;
    const avg = rosterSize > 0 ? profile[c] / rosterSize : 0;
    out[c] = Math.min(bounds.max, Math.max(bounds.min, 1 - NEED_K * avg));
  }
  return out;
}
