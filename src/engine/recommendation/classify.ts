import type { PlayerScore, RecommendationState } from "@/types";

export interface ClassifyThresholds {
  draftNowSurvival: number;
  safeWaitSurvival: number;
  avoidRisk: number;
  topCandidates: number;
}

/** Strength of the survival discount in the decision score. */
export const DECISION_ALPHA = 0.15;

/** decision = riskAdjusted * (1 - α * survival); survival null → 0 (pure riskAdjusted). */
export function decisionScore(s: Pick<PlayerScore, "riskAdjusted" | "survival">): number {
  return s.riskAdjusted * (1 - DECISION_ALPHA * (s.survival ?? 0));
}

/**
 * Assign recommendation states (spec 16). Returns a new array in the same order.
 *  - AVOID: riskScore >= avoidRisk (conservative profile).
 *  - Candidates = top `topCandidates` non-AVOID players by riskAdjusted.
 *  - Best candidate by decisionScore: DRAFT if on the clock, else TAKE (exactly one).
 *  - Other candidates: survival < draftNowSurvival → TAKE; > safeWaitSurvival → WAIT; else RISKY WAIT.
 *    Unknown survival → WAIT.
 *  - Non-candidates (and not AVOID) → WAIT.
 * Ties on decision score break by higher riskAdjusted, then playerId.
 */
export function classify(
  scores: PlayerScore[],
  opts: { isUserOnClock: boolean; thresholds: ClassifyThresholds },
): PlayerScore[] {
  const t = opts.thresholds;
  const state = new Map<string, RecommendationState>();
  const candidates: PlayerScore[] = [];

  const byAdj = [...scores].sort((a, b) => b.riskAdjusted - a.riskAdjusted || a.playerId.localeCompare(b.playerId));
  for (const s of byAdj) {
    if (s.riskScore >= t.avoidRisk) state.set(s.playerId, "AVOID");
    else if (candidates.length < t.topCandidates) candidates.push(s);
    else state.set(s.playerId, "WAIT");
  }

  let best: PlayerScore | null = null;
  for (const c of candidates) {
    if (
      !best ||
      decisionScore(c) > decisionScore(best) ||
      (decisionScore(c) === decisionScore(best) && c.riskAdjusted > best.riskAdjusted)
    ) best = c;
  }

  for (const c of candidates) {
    if (c === best) state.set(c.playerId, opts.isUserOnClock ? "DRAFT" : "TAKE");
    else if (c.survival == null) state.set(c.playerId, "WAIT");
    else if (c.survival < t.draftNowSurvival) state.set(c.playerId, "TAKE");
    else if (c.survival > t.safeWaitSurvival) state.set(c.playerId, "WAIT");
    else state.set(c.playerId, "RISKY WAIT");
  }

  return scores.map((s) => ({ ...s, recommendation: state.get(s.playerId) ?? "WAIT" }));
}
