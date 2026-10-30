import { VIEW_COUNT } from "./lines";

/**
 * The standings objective. Two kinds, both evaluated per simulated completion of the draft and averaged over the completions (so the
 * nonlinear terms see the whole distribution).
 *
 * kind "h2h" (default; the league is Yahoo H2H 9-cat, a week is won with >= 5 of 9 categories). With W_v = the user's average weekly
 * matchup win probability vs the 13 opponents' final rosters in view v (engine/standings-opt/h2h.ts):
 *
 *     J = 100 · ( Σ_v w_v W_v / Σ w_v  +  μ · min_v W_v )   −   ν · Σ_v max(0, rank_v − topK)
 *
 * The roto term (ν per roto rank place outside the top-K, per view) is the SECONDARY / tiebreak signal: Yahoo also ranks the teams by
 * roto points per view and the user wants to be in the top 5 there too.
 *
 * kind "roto": roto points p_v and ranks r_v per view:
 *
 *     J = Σ_v w_v · p_v   +   μ · min_v p_v   −   ν · Σ_v max(0, r_v − topK)
 *
 * "max-total" is the roto kind with μ = ν = 0.
 */
export interface ObjectiveParams {
  kind: "h2h" | "roto";
  /** Weight per view, [proj, total, avg]. */
  weights: [number, number, number];
  /** Bonus for the worst view (h2h: per unit of win probability ×100 scale; roto: per roto point). */
  mu: number;
  /** Penalty per roto rank place outside the top `topK`, per view. */
  nu: number;
  topK: number;
}

export const OBJECTIVE_MODES = ["h2h", "robust", "max-total", "classic"] as const;
export type ObjectiveMode = (typeof OBJECTIVE_MODES)[number];
export const DEFAULT_OBJECTIVE_MODE: ObjectiveMode = "h2h";
export const OBJECTIVE_LABELS: Record<ObjectiveMode, string> = {
  h2h: "H2H weekly wins",
  robust: "Robust top-5 roto",
  "max-total": "Max total roto",
  classic: "Classic z-score",
};

/** Tuned by `pnpm standings:backtest` (see README, "Standings optimizer"). */
export const H2H_PARAMS: ObjectiveParams = { kind: "h2h", weights: [1, 1, 1], mu: 0.5, nu: 0.5, topK: 5 };
export const ROBUST_PARAMS: ObjectiveParams = { kind: "roto", weights: [1, 1, 1], mu: 1, nu: 2, topK: 5 };
export const MAX_TOTAL_PARAMS: ObjectiveParams = { kind: "roto", weights: [1, 1, 1], mu: 0, nu: 0, topK: 5 };

/** Parameters of a mode; "classic" has no standings objective (null). */
export function objectiveParamsFor(mode: ObjectiveMode): ObjectiveParams | null {
  return mode === "h2h" ? H2H_PARAMS : mode === "robust" ? ROBUST_PARAMS : mode === "max-total" ? MAX_TOTAL_PARAMS : null;
}

/** Share of the Draft Score taken by the standings dimension (the other weights are scaled by 1 - this). */
export const DEFAULT_ROTO_WEIGHT = 0.45;

/** J of one completed draft. `points` / `ranks` (roto) and `wins` (h2h average matchup win probability) are per view in OPT_VIEWS order. */
export function objectiveOf(points: ArrayLike<number>, ranks: ArrayLike<number>, wins: ArrayLike<number>, p: ObjectiveParams): number {
  let over = 0;
  for (let v = 0; v < VIEW_COUNT; v++) if (ranks[v] > p.topK) over += ranks[v] - p.topK;
  if (p.kind === "h2h") {
    let sum = 0, wsum = 0, min = Infinity;
    for (let v = 0; v < VIEW_COUNT; v++) {
      sum += p.weights[v] * wins[v];
      wsum += p.weights[v];
      if (wins[v] < min) min = wins[v];
    }
    return 100 * (sum / (wsum || 1) + p.mu * min) - p.nu * over;
  }
  let sum = 0, min = Infinity;
  for (let v = 0; v < VIEW_COUNT; v++) {
    sum += p.weights[v] * points[v];
    if (points[v] < min) min = points[v];
  }
  return sum + p.mu * min - p.nu * over;
}
