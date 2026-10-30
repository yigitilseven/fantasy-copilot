import { leagueConfig } from "@/config/default-league";
import type { Db } from "@/db/client";
import { activeOpponentModel } from "@/db/history";
import { getAllPlayerRecords, getDraft } from "@/db/repository";
import { buildSimPlayers, buildSurvivalInput, simulateSurvival } from "@/engine";
import { computeValuations } from "@/engine/valuation/value";
import { rotoPlayers, scoreWithRoto } from "@/engine/recommendation/with-roto";
import { analyzeRoto, type RotoAnalysis } from "@/engine/standings-opt/expected";
import { H2H_PARAMS, objectiveParamsFor, type ObjectiveMode } from "@/engine/standings-opt/objective";
import { outlookOf, type StandingsOutlook } from "@/engine/standings-opt/summary";
import {
  defaultStrategy, effectiveNeedWeights, projectionModeOf, objectiveModeOf, projectionSpecOf, projectionWeightOf, puntedCategories, robustnessModeOf, robustnessOf, strategyKey, valuationOptionsOf,
} from "@/engine/recommendation/strategy";
import { applyProjectionBlend, projectionDisagreement } from "@/engine/projection/blend";
import { sourceZ, type SourceZ } from "@/engine/projection/disagreement";
import { categoryProfile } from "@/engine/roster/needs";
import { deriveDraft, simSeed } from "@/store/derived";
import { CATEGORIES } from "@/types";
import { injuryText } from "@/engine/recommendation/explain";
import type { DraftState, InjuryStatus, Strategy, PlayerRecord, PlayerScore, PlayerValuation, RecommendationState, RiskLabel } from "@/types";

/** Response of GET /api/draft/[id]/recommendations (consumed by the Yahoo userscript overlay). */
export interface RecommendationsResponse {
  draftId: number;
  currentPick: number;
  totalPicks: number;
  status: "active" | "complete";
  teams: number;
  userSlot: number;
  onClock: boolean;
  /** The user's next pick at or after currentPick (== currentPick while on the clock); null when none is left. */
  userNextPick: number | null;
  /** userNextPick - currentPick (0 while on the clock); null when none is left. */
  picksUntilUser: number | null;
  strategy: { preset: string; riskTolerance: number; puntedCategories: string[] };
  /**
   * Projection mix in use: mode "auto" (per-player rate/volume weights; `weight` is then only the stored fixed weight) or
   * "fixed" (weight = Yahoo share of the Yahoo 2026-27 / real 2025-26 blend); robustnessMode "auto" (round-aware) | "always"
   * (lambda = `robustness`) | "never".
   */
  projection: { mode: "auto" | "fixed"; weight: number; robustness: number; robustnessMode: "auto" | "always" | "never" };
  /** Final roster-fit weights (need x emphasis; punted = 0), all 9 categories, sorted by weight desc. */
  needs: { category: string; weight: number }[];
  roster: { pick: number; playerId: string; name: string; positions: string; nbaTeam: string }[];
  top: {
    playerId: string; name: string; nbaTeam: string; positions: string; adp: number;
    state: RecommendationState; score: number; nineCat: number; rosterFit: number; survival: number | null;
    riskLabel: RiskLabel; reason: string;
    /** Standings dimension 0-100 and the change of weekly matchup win probability (fraction); null when no standings analysis fed the score. */
    roto: number | null; dWinProb: number | null;
    /** Injury status ("healthy" | "day-to-day" | "out" | "out-for-season") and a short note ("Out — est. return Nov 15 (ESPN, Oct 6)"; null when healthy). */
    status: InjuryStatus; injuryNote: string | null;
  }[];
  /** Objective in use and the projected finish (roto per view, weekly H2H outlook); null for "classic" or when no user pick is left. */
  objective: ObjectiveMode;
  standings: StandingsOutlook | null;
  /** ALL available players, ranked by score (riskAdjusted). */
  board: { playerId: string; name: string; nbaTeam: string; state: string; score: number; rank: number; status: InjuryStatus }[];
  generatedAt: string;
  simMs: number | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** FNV-1a over strings/numbers; cheap fingerprints for cache keys. */
function fnv(parts: Iterable<string | number>): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x7c;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Fingerprint of everything valuations depend on (player set, projections, market rank/ADP). */
export function playerFingerprint(records: PlayerRecord[]): string {
  const parts: (string | number)[] = [records.length];
  for (const r of records) {
    const p = r.projection;
    parts.push(r.player.id, r.market.rank, r.market.yahooAdp, p.pts, p.fgm, p.fga, p.ftm, p.fta, p.threePm, p.reb, p.ast, p.stl, p.blk, p.tov);
  }
  return fnv(parts);
}

/** Fingerprint of the injury/status inputs of the risk model (changes when a news update lands). */
export function riskFingerprint(records: PlayerRecord[]): string {
  const parts: (string | number)[] = [];
  for (const r of records) {
    const k = r.risk;
    parts.push(r.player.id, k.currentStatus, k.projectedGames, k.gamesMissed ?? "", k.estReturn ?? "", k.statusUpdatedAt ?? "");
  }
  return fnv(parts);
}

let memoEpoch = 0;
/** Drops cached valuations and bumps the memo epoch so every memoized recommendation is recomputed (after a news update). */
export function invalidateRecommendationCaches(): void {
  valCache = null;
  disCache = null;
  srcCache = null;
  memoEpoch++;
}

/** Keyed by the projection weight too (the fingerprint already changes with the blended lines; the weight makes it explicit). */
let valCache: { fp: string; weight: number | "auto"; usage: boolean; valuations: Record<string, PlayerValuation> } | null = null;
function valuationsFor(records: PlayerRecord[], weight: number | "auto", strategy: Strategy): { valuations: Record<string, PlayerValuation>; fp: string } {
  const fp = playerFingerprint(records);
  const opts = valuationOptionsOf(strategy);
  const usage = !!opts.usageAdjustTO;
  if (valCache?.fp !== fp || valCache.weight !== weight || valCache.usage !== usage) valCache = { fp, weight, usage, valuations: computeValuations(records, opts).valuations };
  return { valuations: valCache.valuations, fp };
}

let disCache: { fp: string; map: Record<string, number> } | null = null;
let srcCache: { fp: string; map: Record<string, SourceZ> } | null = null;
function rawFingerprint(raw: PlayerRecord[]): string {
  const parts: (string | number)[] = [raw.length];
  for (const r of raw) {
    const c = r.projection.components;
    parts.push(r.player.id, r.market.rank, c?.yahoo?.pts ?? "", c?.actual?.pts ?? "", c?.yahoo?.reb ?? "", c?.actual?.reb ?? "", c?.fantasyPros?.pts ?? "", c?.actual?.ast ?? "");
  }
  return fnv(parts);
}
/** Yahoo-vs-2025-26 disagreement per player (computed from the UNBLENDED records, so independent of the weight). */
function disagreementFor(raw: PlayerRecord[]): Record<string, number> {
  const fp = rawFingerprint(raw);
  if (disCache?.fp !== fp) disCache = { fp, map: projectionDisagreement(raw) };
  return disCache.map;
}
/** z vectors of the projection side vs the real stats (round-aware "auto" disagreement handling). */
function sourcesFor(raw: PlayerRecord[]): Record<string, SourceZ> {
  const fp = rawFingerprint(raw);
  if (srcCache?.fp !== fp) srcCache = { fp, map: sourceZ(raw) };
  return srcCache.map;
}

interface Core {
  roto: RotoAnalysis | null;
  scores: PlayerScore[];
  survivalOk: boolean;
  simMs: number | null;
}
const MEMO_MAX = 40;
const memo = new WeakMap<Db, Map<string, Core>>();
export const recommendationCacheStats = { hits: 0, misses: 0, sims: 0 };
export function resetRecommendationCaches(): void {
  valCache = null;
  disCache = null;
  srcCache = null;
  memoEpoch = 0;
  recommendationCacheStats.hits = recommendationCacheStats.misses = recommendationCacheStats.sims = 0;
}

/** Players drafted per team, index = slot - 1. */
export function rostersBySlot(draft: DraftState): string[][] {
  const rosters: string[][] = Array.from({ length: draft.teams }, () => []);
  for (const p of draft.picks) rosters[p.teamSlot - 1]?.push(p.playerId);
  return rosters;
}

function computeCore(db: Db, draft: DraftState, records: PlayerRecord[], valuations: Record<string, PlayerValuation>, fp: string, dis?: { disagreement?: Record<string, number>; sources?: Record<string, SourceZ> }): Core {
  const d = deriveDraft(draft)!;
  const strategy = draft.strategy ?? defaultStrategy();
  if (d.complete) return { roto: null, scores: [], survivalOk: false, simMs: null };

  const key = [draft.id, d.currentPick, draft.picks.length, fnv(draft.picks.map((p) => p.playerId)), strategyKey(strategy), JSON.stringify(activeOpponentModel(db) ?? null), fp, riskFingerprint(records), memoEpoch].join("|");
  let m = memo.get(db);
  if (!m) memo.set(db, (m = new Map()));
  const hit = m.get(key);
  if (hit) {
    recommendationCacheStats.hits++;
    return hit;
  }
  recommendationCacheStats.misses++;

  // Survival, same inputs and seed derivation as the client store (kickSimulation), so app and overlay agree.
  let survival: Record<string, number> | null = null;
  let simMs: number | null = null;
  try {
    const drafted = new Set(d.draftedIds);
    const players = buildSimPlayers(
      records
        .filter((r) => !drafted.has(r.player.id))
        .map((r) => ({
          id: r.player.id,
          adp: r.market.yahooAdp,
          adpStdDev: r.market.adpStdDev,
          value: valuations[r.player.id]?.nineCat ?? 0,
          positions: r.player.positions,
        })),
    );
    const built = buildSurvivalInput({
      currentPick: d.currentPick, teams: draft.teams, userSlot: draft.userSlot, rounds: draft.rounds,
      players, simulations: leagueConfig.simulations, seed: simSeed(draft.id, d.currentPick), model: activeOpponentModel(db),
    });
    if (built) {
      recommendationCacheStats.sims++;
      const res = simulateSurvival(built.input);
      survival = res.survival;
      simMs = Math.round(res.elapsedMs);
    }
  } catch {
    survival = null;
    simMs = null;
  }

  const rosters = rostersBySlot(draft);
  const { scores, roto } = scoreWithRoto({
    records, valuations,
    draftedIds: d.draftedIds,
    userRosterIds: d.userRosterIds,
    currentPick: d.currentPick,
    config: { teams: draft.teams },
    rounds: draft.rounds,
    userNextPick: d.isUserOnClock ? d.survivalTarget : d.userNextPick,
    isUserOnClock: d.isUserOnClock,
    survival,
    strategy,
    disagreement: dis?.disagreement,
    sources: dis?.sources,
  }, { teams: draft.teams, rounds: draft.rounds, userSlot: draft.userSlot, rosters, model: activeOpponentModel(db), seed: simSeed(draft.id, d.currentPick) });
  const core: Core = { roto, scores, survivalOk: survival !== null, simMs };
  m.set(key, core);
  if (m.size > MEMO_MAX) m.delete(m.keys().next().value!);
  return core;
}

/** Null when the draft does not exist. Pure compute (+ in-process caches); the route only does HTTP. */
export function computeRecommendations(db: Db, draftId: number, opts: { limit?: number; fantasyPros?: boolean } = {}): RecommendationsResponse | null {
  const draft = getDraft(db, draftId);
  if (!draft) return null;
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)));
  const d = deriveDraft(draft)!;
  const strategy = draft.strategy ?? defaultStrategy();
  const raw = getAllPlayerRecords(db, Date.now(), { withComponents: true, fantasyPros: opts.fantasyPros });
  const spec = projectionSpecOf(strategy);
  const weight = projectionWeightOf(strategy);
  const records = applyProjectionBlend(raw, spec);
  const { valuations, fp } = valuationsFor(records, spec, strategy);
  const byId = new Map(records.map((r) => [r.player.id, r]));

  const rmode = robustnessModeOf(strategy);
  const core = computeCore(db, draft, records, valuations, fp, rmode === "always" ? { disagreement: disagreementFor(raw) } : rmode === "auto" ? { sources: sourcesFor(raw) } : undefined);

  const weights = effectiveNeedWeights(categoryProfile(d.userRosterIds, valuations), d.userRosterIds.length, strategy);
  const needs = CATEGORIES.map((c, i) => ({ category: c as string, weight: r3(weights[c]), i }))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map(({ category, weight }) => ({ category, weight }));

  const roster = draft.picks
    .filter((p) => p.teamSlot === draft.userSlot)
    .map((p) => {
      const r = byId.get(p.playerId);
      return { pick: p.pick, playerId: p.playerId, name: r?.player.name ?? p.playerId, positions: r?.player.positions.join("/") ?? "", nbaTeam: r?.player.nbaTeam ?? "" };
    });

  const top = core.scores.slice(0, limit).map((s) => {
    const r = byId.get(s.playerId)!;
    return {
      playerId: s.playerId, name: r.player.name, nbaTeam: r.player.nbaTeam, positions: r.player.positions.join("/"),
      adp: r.market.yahooAdp, state: s.recommendation, score: r1(s.riskAdjusted), nineCat: r1(s.nineCat), rosterFit: r1(s.rosterFit),
      survival: s.survival == null ? null : r3(s.survival), riskLabel: s.riskLabel, reason: s.reason,
      roto: s.roto === undefined ? null : r1(s.roto), dWinProb: s.dWinProb === undefined ? null : r3(s.dWinProb),
      status: r.risk.currentStatus, injuryNote: injuryText(r.risk),
    };
  });
  const board = core.scores.map((s, i) => {
    const r = byId.get(s.playerId)!;
    return { playerId: s.playerId, name: r.player.name, nbaTeam: r.player.nbaTeam, state: s.recommendation as string, score: r1(s.riskAdjusted), rank: i + 1, status: r.risk.currentStatus };
  });

  return {
    draftId: draft.id,
    currentPick: draft.currentPick,
    totalPicks: draft.teams * draft.rounds,
    status: draft.status,
    teams: draft.teams,
    userSlot: draft.userSlot,
    onClock: d.isUserOnClock,
    userNextPick: d.userNextPick,
    picksUntilUser: d.userNextPick == null ? null : d.userNextPick - draft.currentPick,
    strategy: { preset: strategy.preset, riskTolerance: strategy.riskTolerance, puntedCategories: puntedCategories(strategy) },
    projection: { mode: projectionModeOf(strategy), weight, robustness: robustnessOf(strategy), robustnessMode: rmode },
    objective: objectiveModeOf(strategy),
    standings: core.roto ? outlookOf(core.roto, draft.teams) : null,
    needs, roster, top, board,
    generatedAt: new Date().toISOString(),
    simMs: core.simMs,
  };
}

/**
 * What the app showed for `playerId` just before pick `pick` was made: rank/state from the memoized recommendations of the
 * state whose pick on the clock was `pick`. Never computes anything; null when nothing was cached (history records null then).
 */
export function peekCachedRank(db: Db, draftId: number, pick: number, playerId: string): { rank: number; state: string; available: number } | null {
  const m = memo.get(db);
  if (!m) return null;
  const prefix = `${draftId}|${pick}|`;
  let found: Core | null = null;
  for (const [key, core] of m) if (key.startsWith(prefix)) found = core;
  if (!found || !found.scores.length) return null;
  const i = found.scores.findIndex((s) => s.playerId === playerId);
  return i < 0 ? null : { rank: i + 1, state: String(found.scores[i].recommendation), available: found.scores.length };
}


/** Response of GET /api/draft/[id]/standings: the standings analysis of the current state (candidate gains + the projected finish). */
export interface StandingsResponse {
  draftId: number;
  currentPick: number;
  objective: ObjectiveMode;
  /** Candidate evaluations feeding the "Roto" score dimension (empty for "classic" and for finished drafts). */
  analysis: RotoAnalysis | null;
  outlook: StandingsOutlook | null;
}

/**
 * Standings analysis for the current state, through the same memoized machinery as the recommendations (so the app and the overlay show
 * identical numbers). "classic" and finished drafts still get a projected finish (no candidates). Null when the draft does not exist.
 */
export function computeStandings(db: Db, draftId: number, opts: { fantasyPros?: boolean } = {}): StandingsResponse | null {
  const draft = getDraft(db, draftId);
  if (!draft) return null;
  const d = deriveDraft(draft)!;
  const strategy = draft.strategy ?? defaultStrategy();
  const mode = objectiveModeOf(strategy);
  const raw = getAllPlayerRecords(db, Date.now(), { withComponents: true, fantasyPros: opts.fantasyPros });
  const spec = projectionSpecOf(strategy);
  const records = applyProjectionBlend(raw, spec);
  const { valuations, fp } = valuationsFor(records, spec, strategy);
  let analysis: RotoAnalysis | null = null;
  if (!d.complete && mode !== "classic") {
    const rmode = robustnessModeOf(strategy);
    analysis = computeCore(db, draft, records, valuations, fp, rmode === "always" ? { disagreement: disagreementFor(raw) } : rmode === "auto" ? { sources: sourcesFor(raw) } : undefined).roto;
  }
  if (!analysis) {
    analysis = analyzeRoto({
      teams: draft.teams, rounds: draft.rounds, userSlot: draft.userSlot, currentPick: d.complete ? draft.teams * draft.rounds + 1 : d.currentPick, rosters: rostersBySlot(draft),
      players: rotoPlayers(records, valuations), model: activeOpponentModel(db), seed: simSeed(draft.id, d.currentPick), objective: objectiveParamsFor(mode) ?? H2H_PARAMS,
      autoByAdp: 0, autoBySurrogate: 0,
    });
    return { draftId, currentPick: draft.currentPick, objective: mode, analysis: null, outlook: outlookOf(analysis, draft.teams) };
  }
  return { draftId, currentPick: draft.currentPick, objective: mode, analysis, outlook: outlookOf(analysis, draft.teams) };
}
