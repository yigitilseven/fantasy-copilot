import type { Position, SimPlayer } from "@/types";
import type { Rng } from "./rng";

/**
 * Single-pick opponent model used by local mock drafts (spec 13). Same model as the
 * survival simulator: key = adp + adpStdDev * N(0,1) - VALUE_EPS * value, lowest key wins,
 * so ADP behaves as a distribution (reaches and falls happen).
 *
 * Light positional need (kept intentionally simple): the key of a candidate gets
 * NEED_PENALTY added (i.e. it looks ~NEED_PENALTY picks "later") when
 *  - the team already has >= MAX_PURE_C players whose only position is C and the
 *    candidate is also a pure C, or
 *  - the team already has >= MAX_PURE_GUARDS players whose positions are all PG/SG and
 *    the candidate is also guard-only.
 * Deterministic given the rng (one normal() draw per available player, in input order).
 */
export const VALUE_EPS = 0.01;
export const NEED_PENALTY = 25;
export const MAX_PURE_C = 3;
export const MAX_PURE_GUARDS = 4;

export interface OpponentOptions {
  /** Positions of each player already on this team's roster. */
  teamRosterPositions?: Position[][];
  /** Fitted parameters (see engine/analysis/fit); absent = defaults. */
  model?: { k: number; autopickShare: number };
}

const isPureC = (p: Position[]) => p.length > 0 && p.every((x) => x === "C");
const isPureGuard = (p: Position[]) => p.length > 0 && p.every((x) => x === "PG" || x === "SG");

/** Returns the id of the player this opponent drafts, or null when nothing is available. */
export function pickForOpponent(
  available: SimPlayer[],
  rng: Rng,
  opts: OpponentOptions = {},
): string | null {
  if (available.length === 0) return null;
  const roster = opts.teamRosterPositions ?? [];
  const cCount = roster.filter(isPureC).length;
  const guardCount = roster.filter(isPureGuard).length;
  const avoidC = cCount >= MAX_PURE_C;
  const avoidG = guardCount >= MAX_PURE_GUARDS;

  const kMul = opts.model && opts.model.k > 0 ? opts.model.k : 1;
  if (opts.model && opts.model.autopickShare > 0 && rng.next() < opts.model.autopickShare) {
    let a = available[0];
    for (const p of available) if (p.adp < a.adp) a = p;
    return a.id;
  }
  let best = available[0].id;
  let bestKey = Infinity;
  for (const p of available) {
    let key = p.adp + kMul * p.adpStdDev * rng.normal() - VALUE_EPS * p.value;
    if (avoidC && isPureC(p.positions)) key += NEED_PENALTY;
    if (avoidG && isPureGuard(p.positions)) key += NEED_PENALTY;
    if (key < bestKey) {
      bestKey = key;
      best = p.id;
    }
  }
  return best;
}
