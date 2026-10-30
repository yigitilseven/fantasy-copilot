import type { Category, CategoryScores, PlayerRecord, PlayerScore, PlayerValuation, RosterSlot, Strategy } from "@/types";
import { CATEGORIES } from "@/types";
import { leagueConfig } from "@/config/default-league";
import { categoryProfile, needWeights } from "../roster/needs";
import { rosterFitValue } from "../roster/fit";
import { flexibility, positionalScarcity, valueOverReplacement } from "../roster/scarcity";
import { availableShare, hasNearReturn, riskLabel, riskPenalty, riskScore, seasonShare } from "../risk/injury";
import { classify, type ClassifyThresholds } from "./classify";
import { explain, ilStashText, injuryText, rotoReason, topNeedCategories } from "./explain";
import { AUTO_LAMBDA, lineDistance, roundAwareValue, type SourceZ } from "../projection/disagreement";
import type { RotoAnalysis } from "../standings-opt/expected";
import { DEFAULT_ROTO_WEIGHT } from "../standings-opt/objective";
import { isNeutralStrategy, puntedCategories, robustnessModeOf, robustnessOf } from "./strategy";

export interface DraftWeights {
  nineCat: number;
  rosterFit: number;
  vorp: number;
  scarcity: number;
  adpValue: number;
  flexibility: number;
}

export interface RecommendConfig {
  weights: DraftWeights;
  riskTolerance: number;
  thresholds: ClassifyThresholds;
  teams: number;
  rosterSlots: readonly RosterSlot[];
  needWeightBounds: { min: number; max: number };
  /** Share of the Draft Score taken by the standings ("Roto") dimension when `roto` is supplied; the other weights scale by 1 - this. */
  rotoWeight: number;
}

export interface RecommendInput {
  records: PlayerRecord[];
  valuations: Record<string, PlayerValuation>;
  draftedIds: string[];
  userRosterIds: string[];
  currentPick: number;
  userNextPick: number | null;
  isUserOnClock: boolean;
  survival: Record<string, number> | null;
  config?: Partial<RecommendConfig>;
  /**
   * Optional draft strategy. Its riskTolerance overrides config.riskTolerance; its categoryEmphasis reweights the
   * nineCat and rosterFit dimensions (punted categories, emphasis 0, are ignored). Omitted/neutral = classic scoring.
   */
  strategy?: Strategy;
  /**
   * Per-player |nineCat_yahoo - nineCat_actual| (engine/projection/blend.ts projectionDisagreement). Only used when the
   * strategy has robustness > 0: the player's 9-cat value is reduced by robustness x disagreement, so players strong on
   * BOTH sources are preferred over players whose value depends on one source being right.
   */
  disagreement?: Record<string, number>;
  /**
   * Per-player z vectors of the projection side and of the real 2025-26 stats (engine/projection/disagreement.ts sourceZ). With
   * strategy.robustnessMode "auto" (the default) the value is adjusted by round: a penalty -lambda*d in the early rounds, upside
   * (max of the sources) in the late rounds, interpolated in between. Absent = no adjustment.
   */
  sources?: Record<string, SourceZ>;
  /**
   * Standings analysis (engine/standings-opt analyzeRoto, normally via scoreWithRoto): adds the "Roto" dimension (0-100) for the
   * evaluated candidates and the reason text. Absent = the classic dimensions only.
   */
  roto?: RotoAnalysis;
  /** Evaluation time (ms) for time-dependent risk terms (status recency); default Date.now(). */
  now?: number;
  /** Draft length in rounds (default leagueConfig.rounds); used for the "late rounds" IL-stash rule. */
  rounds?: number;
  /** Injured-list slots (default leagueConfig.ilSlots). */
  ilSlots?: number;
}

/** IL stash: injured-with-return players are considerable when the pick is late and the user has a free IL slot. */
export const IL_STASH_RISK_FACTOR = 0.3;

/**
 * Static normalization anchors for nineCat / rosterFit (computed from the full universe so
 * scores don't inflate as the board thins): best player in the universe -> 100,
 * the poolSize-th best (poolSize = teams * roster slots) -> 50; linear, clamped to 0-100.
 */
export function valueAnchors(
  valuations: Record<string, PlayerValuation>,
  poolSize: number,
): { top: number; ref: number } {
  const sorted = Object.values(valuations).map((v) => v.nineCat).sort((a, b) => b - a);
  if (sorted.length === 0) return { top: 1, ref: 0 };
  const top = sorted[0];
  const ref = sorted[Math.min(poolSize, sorted.length) - 1];
  return { top, ref };
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

function anchorScale(x: number, a: { top: number; ref: number }): number {
  const span = a.top - a.ref;
  if (span <= 0) return 50;
  return clamp(50 + (50 * (x - a.ref)) / span);
}

/** Roto dimension: 100 for the best evaluated candidate, minus this many points per objective point of gap (h2h: per 1% of weekly win probability ×100 scale). */
export const ROTO_SLOPE_H2H = 15;
export const ROTO_SLOPE_ROTO = 5;

/** ADP value: neutral 50, +ADP_SLOPE points per rank the player is undervalued by. */
export const ADP_SLOPE = 2.5;

/** Flexibility: raw n/9 slot types; 3/9 (a lone C) -> 0, 7/9 (e.g. PG/SG/SF) -> 100. */
function flexScale(raw: number): number {
  return clamp(((raw * 9 - 3) / 4) * 100);
}

function resolveConfig(c?: Partial<RecommendConfig>): RecommendConfig {
  return {
    weights: c?.weights ?? leagueConfig.weights,
    riskTolerance: c?.riskTolerance ?? leagueConfig.riskTolerance,
    thresholds: c?.thresholds ?? leagueConfig.thresholds,
    teams: c?.teams ?? leagueConfig.teams,
    rosterSlots: c?.rosterSlots ?? leagueConfig.rosterSlots,
    needWeightBounds: c?.needWeightBounds ?? leagueConfig.needWeightBounds,
    rotoWeight: c?.rotoWeight ?? DEFAULT_ROTO_WEIGHT,
  };
}

/** Rank (1-based) of each id when sorting by key ascending; stable on input order. */
function ranks(items: PlayerRecord[], key: (r: PlayerRecord) => number): Map<string, number> {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const m = new Map<string, number>();
  sorted.forEach((r, i) => m.set(r.player.id, i + 1));
  return m;
}

/**
 * Score every AVAILABLE player. Dimensions (all 0-100):
 *  - nineCat, rosterFit: static universe anchors (see valueAnchors). rosterFit = sum z*needWeight
 *    where needWeights derive from the user's current category profile.
 *  - vorp, scarcity: raw / max over the available pool (floor 0).
 *  - adpValue: 50 + 2.5*(adpRank - valueRank), ranks among available players; positive when the
 *    player's 9-cat rank beats his ADP rank (undervalued by the market).
 *  - flexibility: slot-type count rescaled.
 * With a strategy: nineCat uses sum(z_c * emphasis_c) (anchors recomputed over the adjusted universe), rosterFit uses
 * needWeight_c * emphasis_c (punted categories ignored), and riskTolerance comes from the strategy.
 * draftScore = sum(weights * dims); riskAdjusted = draftScore - riskPenalty;
 * urgency = riskAdjusted * (1 - survival) (null survival -> 0.5).
 * Sorted by riskAdjusted desc, then urgency desc.
 */
export function scorePlayers(input: RecommendInput): PlayerScore[] {
  const cfg = resolveConfig(input.config);
  const drafted = new Set(input.draftedIds);
  const available = input.records.filter((r) => !drafted.has(r.player.id));
  if (available.length === 0) return [];

  const poolSize = cfg.teams * cfg.rosterSlots.length;
  const strat = input.strategy && !isNeutralStrategy(input.strategy) ? input.strategy : undefined;
  const emphasis = input.strategy?.categoryEmphasis;
  const useEmphasis = !!emphasis && CATEGORIES.some((c) => emphasis[c] !== 1);
  const riskTolerance = input.strategy?.riskTolerance ?? cfg.riskTolerance;
  const punted = puntedCategories(input.strategy);

  /**
   * Disagreement handling on top of a base value (the emphasis-weighted sum, or the plain nineCat for ranking):
   *  "never" none; "always" -lambda*d everywhere (d from `disagreement`, else from `sources`); "auto" round-aware (roundAwareValue).
   */
  const rmode = input.strategy ? robustnessModeOf(input.strategy) : "auto";
  const lambda = rmode === "always" ? robustnessOf(input.strategy) : 0;
  const pickForRound = input.isUserOnClock ? input.currentPick : (input.userNextPick ?? input.currentPick);
  const roundNow = Math.ceil(pickForRound / cfg.teams);
  const hasSources = rmode === "auto" && !!input.sources;
  const adjustsByDisagreement = hasSources || (lambda > 0 && !!(input.disagreement || input.sources));
  const disAdjust = (id: string, base: number, emph?: CategoryScores): number => {
    if (hasSources) return roundAwareValue({ blend: base, src: input.sources![id], round: roundNow, lambda: AUTO_LAMBDA, emphasis: emph });
    if (lambda > 0) {
      const d = input.disagreement ? (input.disagreement[id] ?? 0) : input.sources?.[id] ? lineDistance(input.sources[id], emph) : 0;
      return base - lambda * d;
    }
    return base;
  };
  /** Strategy-adjusted value: sum z_c * emphasis_c (== nineCat without a strategy), then the disagreement handling. */
  const adjusted = (v: PlayerValuation): number => {
    let base = v.nineCat;
    if (useEmphasis) {
      base = 0;
      for (const c of CATEGORIES) base += v.z[c] * emphasis![c];
    }
    return disAdjust(v.playerId, base, useEmphasis ? emphasis : undefined);
  };
  // Same static anchors, computed over the strategy-adjusted universe values.
  const anchors = useEmphasis || adjustsByDisagreement
    ? valueAnchors(
        Object.fromEntries(Object.entries(input.valuations).map(([id, v]) => [id, { ...v, nineCat: adjusted(v) }])),
        poolSize,
      )
    : valueAnchors(input.valuations, poolSize);

  const rosterIds = input.userRosterIds;
  const profile = categoryProfile(rosterIds, input.valuations);
  // need weights ignore punted categories (0); final fit weights = need x emphasis
  const nw: CategoryScores = needWeights(profile, rosterIds.length, cfg.needWeightBounds, useEmphasis ? emphasis : undefined);
  const fw: CategoryScores = useEmphasis ? ({ ...nw } as CategoryScores) : nw;
  if (useEmphasis) for (const c of CATEGORIES) fw[c] = nw[c] * emphasis![c];
  const topNeeds = topNeedCategories(nw, 3).filter((c) => !punted.includes(c));

  const vorpRaw = valueOverReplacement(available, input.valuations, {
    teams: cfg.teams, rosterSlots: cfg.rosterSlots, picksMade: input.draftedIds.length,
  });
  const scarRaw = positionalScarcity(available, input.valuations, { teams: cfg.teams, rosterSlots: cfg.rosterSlots });
  let maxVorp = 0, maxScar = 0;
  for (const r of available) {
    maxVorp = Math.max(maxVorp, vorpRaw[r.player.id]);
    maxScar = Math.max(maxScar, scarRaw[r.player.id]);
  }

  const nine = (r: PlayerRecord) => (input.valuations[r.player.id] ? disAdjust(r.player.id, input.valuations[r.player.id].nineCat) : 0);
  const valueRank = ranks(available, (r) => -nine(r));
  const adpRank = ranks(available, (r) => r.market.yahooAdp);

  const nowMs = input.now ?? Date.now();
  // IL stash mode: last 3 rounds or <= 2 open roster spots, and fewer injured players on the roster than IL slots.
  const rounds = input.rounds ?? leagueConfig.rounds;
  const ilSlots = input.ilSlots ?? leagueConfig.ilSlots;
  const round = Math.ceil(input.currentPick / cfg.teams);
  const openSpots = cfg.rosterSlots.length - rosterIds.length;
  const recById = new Map(input.records.map((r) => [r.player.id, r]));
  const ilUsed = rosterIds.filter((id) => {
    const st = recById.get(id)?.risk.currentStatus;
    return st === "out" || st === "out-for-season";
  }).length;
  const stashMode = (round > rounds - 3 || openSpots <= 2) && ilUsed < ilSlots;
  const w = cfg.weights;
  // Standings ("Roto") dimension: relative to the best evaluated candidate; unevaluated players sit below the evaluated ones.
  const roto = input.roto && Object.keys(input.roto.candidates).length > 0 ? input.roto : undefined;
  const rotoW = roto ? Math.min(1, Math.max(0, cfg.rotoWeight)) : 0;
  const rotoSlope = roto?.objective.kind === "h2h" ? ROTO_SLOPE_H2H : ROTO_SLOPE_ROTO;
  let bestGain = -Infinity;
  if (roto) for (const c of Object.values(roto.candidates)) bestGain = Math.max(bestGain, c.gain);
  const rotoScale = (gain: number) => clamp(100 - rotoSlope * (bestGain - gain));
  let rotoFloor = 0;
  if (roto) rotoFloor = Math.max(0, Math.min(...Object.values(roto.candidates).map((c) => rotoScale(c.gain))) - 10);
  const scores: PlayerScore[] = [];
  const addresses = new Map<string, Category[]>();

  for (const r of available) {
    const id = r.player.id;
    const val = input.valuations[id];
    if (!val) continue;

    const nineN = anchorScale(adjusted(val), anchors);
    const fitN = anchorScale(rosterFitValue(val, fw), anchors);
    const vorpN = maxVorp > 0 ? clamp((100 * vorpRaw[id]) / maxVorp) : 0;
    const scarN = maxScar > 0 ? clamp((100 * scarRaw[id]) / maxScar) : 0;
    const adpN = clamp(50 + ADP_SLOPE * (adpRank.get(id)! - valueRank.get(id)!));
    const flexN = flexScale(flexibility(r.player.positions));

    const classicScore =
      w.nineCat * nineN + w.rosterFit * fitN + w.vorp * vorpN +
      w.scarcity * scarN + w.adpValue * adpN + w.flexibility * flexN;
    const cand = roto?.candidates[id];
    const rotoN = roto ? (cand ? rotoScale(cand.gain) : rotoFloor) : undefined;
    const draftScore = rotoN === undefined ? classicScore : (1 - rotoW) * classicScore + rotoW * rotoN;

    let rs = riskScore(r.risk, r.player.age, 82, nowMs);
    const near = hasNearReturn(r.risk, nowMs);
    const stash = stashMode && near;
    if (stash) rs = Math.min(rs, cfg.thresholds.avoidRisk - 1);
    const pen = riskPenalty(rs, draftScore, stash ? riskTolerance * IL_STASH_RISK_FACTOR : riskTolerance);
    // Missed games cost value once: fully while he holds a roster spot, partly when an IL slot absorbs the stretch.
    const share = near ? (stash ? availableShare(r.risk.gamesMissed) : seasonShare(r.risk.gamesMissed)) : 1;
    const riskAdjusted = draftScore * share - pen;
    const surv = input.survival ? (input.survival[id] ?? null) : null;
    const urgency = riskAdjusted * (1 - (surv ?? 0.5));

    addresses.set(id, CATEGORIES.filter((c) => val.z[c] >= 0.5));
    scores.push({
      playerId: id, nineCat: nineN, rosterFit: fitN, vorp: vorpN, scarcity: scarN, adpValue: adpN,
      flexibility: flexN, riskScore: rs, riskLabel: riskLabel(rs), riskPenalty: pen, draftScore,
      riskAdjusted, survival: surv, urgency, recommendation: "WAIT", reason: "", ...(stash ? { ilStash: true } : {}),
      ...(rotoN !== undefined ? { roto: rotoN, ...(cand ? { rotoGain: cand.gain, dWinProb: cand.dWinProb } : {}) } : {}),
    });
  }

  scores.sort((a, b) => b.riskAdjusted - a.riskAdjusted || b.urgency - a.urgency || a.playerId.localeCompare(b.playerId));
  const riskById = new Map(available.map((r) => [r.player.id, r.risk]));
  const classified = classify(scores, { isUserOnClock: input.isUserOnClock, thresholds: cfg.thresholds });
  for (const s of classified) {
    const weakPunted = strat ? punted.filter((c) => (input.valuations[s.playerId]?.z[c] ?? 0) <= -0.5) : [];
    s.reason = explain(s, {
      userNextPick: input.userNextPick, topNeeds, injury: s.ilStash ? null : injuryText(riskById.get(s.playerId)!),
      ilStash: s.ilStash ? ilStashText(riskById.get(s.playerId)!) : undefined, addresses: addresses.get(s.playerId),
      strategy: strat ? { preset: strat.preset, punted, weakPunted } : undefined,
      roto: roto && roto.candidates[s.playerId] ? rotoReason(roto, roto.candidates[s.playerId]) : undefined,
    });
  }
  return classified;
}
