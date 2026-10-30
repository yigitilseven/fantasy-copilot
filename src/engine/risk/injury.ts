import type { Risk, RiskLabel } from "@/types";

/** Max points contributed by each component (sum 110, result clamped to 100). */
export const RISK_WEIGHTS = {
  gamesShortfall: 25, // (gamesInSeason - projectedGames) / 30, capped at 1
  status: 25, // healthy 0, day-to-day 0.2, out 0.8
  history: 15, // injuryHistoryScore
  majorInjury: 10, // boolean
  restRisk: 10,
  availability: 15, // 1 - availabilityScore
  age: 10, // ramps from 0 at age 30 to full at 38
  recency: 5, // fresh (<= 7 days old) non-healthy status report: more uncertainty
} as const;

/** A status reported within this many days adds the recency bonus (decaying linearly to 0). */
export const RECENCY_DAYS = 7;
/** An "out" status with at most this many games missed gets a graded floor instead of the flat 70. */
export const SHORT_ABSENCE_GAMES = 12;
/** "Out" with a known return within this many days is driven by the share of season missed, not the flat floor. */
export const RETURN_HORIZON_DAYS = 125;
/** On the IL the injured stretch costs only part of its games (bench/IL slot absorbs it): value share = 1 - this * missed/82. */
export const IL_VALUE_DISCOUNT = 0.75;

/** True for an "out" player with a known estimated return inside the horizon (~4 months from `now`). */
export function hasNearReturn(risk: Pick<Risk, "currentStatus" | "estReturn">, now: number = Date.now()): boolean {
  if (risk.currentStatus !== "out" || !risk.estReturn) return false;
  const t = Date.parse(risk.estReturn);
  return !Number.isNaN(t) && t - now <= RETURN_HORIZON_DAYS * 86_400_000;
}

/** Share of the season's value kept by an IL stash: 1 - 0.75 * gamesMissed / 82 (floor 0.2). */
export function availableShare(gamesMissed: number | undefined, gamesInSeason = 82): number {
  return Math.max(0.2, 1 - (IL_VALUE_DISCOUNT * Math.max(0, gamesMissed ?? 0)) / gamesInSeason);
}

/** Share of the season's value a player keeps when he occupies a roster spot while out: 1 - gamesMissed / 82 (floor 0.1). */
export function seasonShare(gamesMissed: number | undefined, gamesInSeason = 82): number {
  return Math.max(0.1, 1 - Math.max(0, gamesMissed ?? 0) / gamesInSeason);
}

const STATUS_FACTOR = { healthy: 0, "day-to-day": 0.2, out: 0.8, "out-for-season": 1 } as const;
/** "Out" with a known return: the missed games are priced into value (seasonShare), so status only adds uncertainty. */
const OUT_WITH_RETURN_FACTOR = 0.3;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 0..1: how fresh the status report is (1 = just now, 0 = 7+ days old / unknown). Healthy statuses never count. */
export function statusRecency(risk: Risk, now: number): number {
  if (risk.currentStatus === "healthy" || !risk.statusUpdatedAt) return 0;
  const t = Date.parse(risk.statusUpdatedAt);
  if (Number.isNaN(t)) return 0;
  const ageDays = (now - t) / 86_400_000;
  return ageDays < 0 ? 1 : clamp01(1 - ageDays / RECENCY_DAYS);
}

export function riskScore(risk: Risk, age: number, gamesInSeason = 82, now: number = Date.now()): number {
  if (risk.currentStatus === "out-for-season") return 100;
  const w = RISK_WEIGHTS;
  const near = hasNearReturn(risk, now);
  // With a known return the missed games are priced into value, not risk: measure durability on the healthy baseline.
  const baselineGames = near ? risk.projectedGames + Math.max(0, risk.gamesMissed ?? 0) : risk.projectedGames;
  const score =
    w.gamesShortfall * clamp01((gamesInSeason - baselineGames) / 30) +
    w.status * (near ? OUT_WITH_RETURN_FACTOR : STATUS_FACTOR[risk.currentStatus]) +
    w.history * clamp01(risk.injuryHistoryScore) +
    w.majorInjury * (risk.majorInjuryHistory ? 1 : 0) +
    w.restRisk * clamp01(risk.restRisk) +
    w.availability * (1 - clamp01(risk.availabilityScore)) +
    w.age * clamp01((age - 30) / 8) +
    w.recency * statusRecency(risk, now);
  // "Out" with no (or a far-off) return stays High risk (floor 70 -> AVOID). With a known return inside ~4 months there
  // is no floor: the absence is priced into value by the recommender (seasonShare / availableShare).
  const floor = risk.currentStatus === "out" && !near ? OUT_FLOOR : 0;
  return Math.round(Math.min(100, Math.max(floor, score)) * 10) / 10;
}

export function riskLabel(score: number): RiskLabel {
  return score < 35 ? "Low" : score < 65 ? "Medium" : "High";
}

/**
 * Penalty in draft-score points: draftScore * (score/100) * riskTolerance * 1.5,
 * capped at 60% of draftScore. riskTolerance is the sensitivity (0.30 = conservative;
 * higher = larger penalty). Score 100 at 0.30 → 45% of draftScore.
 */
export function riskPenalty(score: number, draftScore: number, riskTolerance: number): number {
  const raw = Math.max(0, draftScore) * (clamp01(score / 100)) * Math.max(0, riskTolerance) * 1.5;
  return Math.min(raw, Math.max(0, draftScore) * 0.6);
}

/** The old flat "Out" floor, applied by the recommender when an injured-with-return player is NOT an IL-stash candidate. */
export const OUT_FLOOR = 70;
