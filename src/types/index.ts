/**
 * Shared domain types. These are the contracts between /engine, /db, /store and UI.
 * /engine must only depend on this file and /config — never React, Next.js, Yahoo or the DB.
 */

export const CATEGORIES = ["PTS", "3PM", "REB", "AST", "STL", "BLK", "FG%", "FT%", "TO"] as const;
export type Category = (typeof CATEGORIES)[number];
export type CategoryScores = Record<Category, number>;

export const POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
export type Position = (typeof POSITIONS)[number];

/** Yahoo-style roster slots. G = PG/SG, F = SF/PF, UTIL = any, BN = bench (any). */
export type RosterSlot = Position | "G" | "F" | "UTIL" | "BN";

export interface Player {
  id: string;
  yahooPlayerKey: string | null;
  name: string;
  nbaTeam: string;
  positions: Position[];
  age: number;
}

/** Per-game projections (except `games`). */
export interface Projection {
  playerId: string;
  games: number;
  minutes: number;
  pts: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  /**
   * Where the line comes from (additive; set by getAllPlayerRecords): "yahoo-2026-27" = Yahoo's own projection captured
   * from the draft room (per game = Yahoo totals / GP, attempts derived), "nba-stats" = last-season NBA.com blend.
   */
  projectionSource?: ProjectionSource;
  /** Both source lines (additive; set by getAllPlayerRecords) so the blend can be re-weighted client-side. */
  components?: ProjectionComponents;
  /** Present when projectionSource is "blend" (see engine/projection/blend.ts). */
  blend?: ProjectionBlendInfo;
}

export type ProjectionSource = "yahoo-2026-27" | "consensus-2026-27" | "nba-stats" | "blend";

/** A per-game line (except `games`) from one source. */
export interface ProjectionLine {
  games: number;
  minutes: number;
  pts: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
}

export interface ProjectionComponents {
  /** Yahoo 2026-27 projection as a per-game line (games = Yahoo GP); null when not captured/usable. */
  yahoo: ProjectionLine | null;
  /** Real 2025-26 per-game line (games = 2025-26 GP); null for rookies / players without NBA.com stats. */
  actual: ProjectionLine | null;
  /** FantasyPros consensus 2026-27 projection (per game, minutes = MIN/GP); null/absent when not cached or player not listed. */
  fantasyPros?: ProjectionLine | null;
  /**
   * The forward-looking "projection side" of the blend: Yahoo by default; average(Yahoo, FantasyPros) per stat only when FantasyPros is opted in, else whichever
   * exists. Absent = Yahoo (records built before FantasyPros existed).
   */
  projection?: ProjectionLine | null;
  /** Real 2024-25 per-game line (per-36 shrinkage of small 2025-26 samples, weight rules). */
  actualPrev?: ProjectionLine | null;
  /** Facts the per-player weight rules need (see engine/projection/blend.ts playerBlendWeights). */
  evidence?: BlendEvidence;
}

export interface BlendEvidence {
  /** Age in the projected 2026-27 season, NBA.com convention (age at season end = DB age + 1). */
  age: number;
  /** 2026-27 team (Yahoo's), 2025-26 and 2024-25 NBA.com teams; null when unknown. */
  team26: string | null;
  team25: string | null;
  team24: string | null;
  /** First NBA season (start year, 2025 = 2025-26 rookie) from the NBA.com player index; null when unknown. */
  fromYear: number | null;
}

export interface ProjectionBlendInfo {
  /** The requested Yahoo weight (0..1). */
  weight: number;
  /** The weight actually applied to this player (1 = Yahoo only, 0 = actual only). */
  effectiveWeight: number;
  /** Why effectiveWeight differs from weight (absent when it does not). */
  reason?: "low-gp" | "no-actual" | "no-yahoo";
  /** The projection side of the blend (Yahoo; or average(Yahoo, FantasyPros) when opted in). */
  yahoo: ProjectionLine | null;
  actual: ProjectionLine | null;
  /** "auto" = per-player rate/volume weights (engine/projection/blend.ts v2); absent/"fixed" = one global weight. */
  mode?: "fixed" | "auto";
  /** Auto mode: projection share of the per-36 rates and of the volume (games, minutes), and the rules that set them. */
  wRate?: number;
  wVol?: number;
  reasons?: string[];
  /** Auto mode: minutes per game assumed for the projection side (see impliedMinutes). */
  yahooMinutes?: number;
}

export interface Market {
  playerId: string;
  yahooAdp: number;
  adpStdDev: number;
  rank: number;
}

export type InjuryStatus = "healthy" | "day-to-day" | "out" | "out-for-season";

export interface Risk {
  playerId: string;
  projectedGames: number;
  currentStatus: InjuryStatus;
  /** 0 (clean) – 1 (chronic). */
  injuryHistoryScore: number;
  /** 0 – 1, load-management likelihood. */
  restRisk: number;
  /** 0 – 1, share of last season's games played. */
  availabilityScore: number;
  majorInjuryHistory: boolean;
  updatedAt: string;
  // --- optional: merged in from the news/injury ingestion (player_status_updates / player_news); absent on plain CSV data.
  /** Injury text, e.g. "Knee" / "Right ankle sprain". */
  injuryNote?: string;
  /** Estimated return, ISO date (YYYY-MM-DD). */
  estReturn?: string;
  /** Source of the status ("ESPN", "CBS", "RotoWire", "cleared"). */
  statusSource?: string;
  /** ISO timestamp the status was reported (first seen when the source gives no date). */
  statusUpdatedAt?: string;
  /** Regular-season games expected to be missed because of the current injury (from estReturn). */
  gamesMissed?: number;
  /** Latest headlines mentioning the player (<= 3, newest first). */
  latestNews?: PlayerNewsItem[];
}

export interface PlayerNewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

/** Everything the engine needs to know about one player. */
export interface PlayerRecord {
  player: Player;
  projection: Projection;
  market: Market;
  risk: Risk;
}

/** "yahoo-dom": picks read off the Yahoo draft room page by the browser userscript (extension/). */
export type PickSource = "manual" | "yahoo" | "yahoo-dom" | "simulation";

export interface DraftPick {
  pick: number;
  round: number;
  teamSlot: number;
  playerId: string;
  source: PickSource;
  timestamp: string;
}

export type DraftStatus = "active" | "complete";

export type StrategyPreset = "balanced" | "punt-ft" | "punt-fg" | "punt-to" | "punt-ast" | "punt-3pm" | "punt-pts" | "custom";

/** Draft strategy (see engine/recommendation/strategy.ts). categoryEmphasis: multiplier per category, 0 = punted. */
export interface Strategy {
  preset: StrategyPreset;
  /** 0..1; how heavily injury risk is penalized (0.3 conservative, 0.15 balanced, 0.05 aggressive). */
  riskTolerance: number;
  categoryEmphasis: CategoryScores;
  /** 0..1 share of Yahoo's 2026-27 projection in the blended line (rest = real 2025-26); used when projectionMode is "fixed". Absent = DEFAULT_PROJECTION_WEIGHT. */
  projectionWeight?: number;
  /** "auto" (default) = per-player rate/volume weights; "fixed" = projectionWeight for everybody. */
  projectionMode?: "auto" | "fixed";
  /** >= 0; weight of the consistency penalty -lambda*d on 9-cat value in "always" mode. */
  robustness?: number;
  /** "auto" (default) = round-aware disagreement handling (penalty early, upside late); "always" = lambda everywhere; "never" = off. */
  robustnessMode?: "auto" | "always" | "never";
  /**
   * What the standings engine optimizes (engine/standings-opt): "h2h" (default; expected weekly H2H wins), "robust" (roto top-5 in every
   * view), "max-total" (roto points) or "classic" (z-score only, the pre-standings behavior). Absent = "h2h".
   */
  objective?: "h2h" | "robust" | "max-total" | "classic";
}

export interface DraftState {
  id: number;
  teams: number;
  userSlot: number;
  rounds: number;
  /** The overall pick number that is "on the clock" (1-based). teams*rounds+1 when complete. */
  currentPick: number;
  status: DraftStatus;
  picks: DraftPick[];
  /** Always present on drafts loaded from the DB (balanced/conservative when none was saved). */
  strategy?: Strategy;
}

// ---------------------------------------------------------------- valuation

export interface ValuationContext {
  /** Population used for means/std devs (player ids). */
  poolIds: string[];
  means: Record<string, number>;
  stdDevs: Record<string, number>;
  leagueFgPct: number;
  leagueFtPct: number;
}

export interface PlayerValuation {
  playerId: string;
  /** Per-category z-scores (TO already inverted, FG%/FT% are standardized volume impacts). */
  z: CategoryScores;
  /** Sum of the 9 z-scores. */
  nineCat: number;
}

// ---------------------------------------------------------------- simulation

export interface SimPlayer {
  id: string;
  adp: number;
  adpStdDev: number;
  /** Raw 9-cat value; used as a mild tiebreaker by opponents. */
  value: number;
  positions: Position[];
}

export interface SimulationInput {
  /** Pick currently on the clock. */
  currentPick: number;
  /** The pick we want survival probabilities for (our next pick). Picks in [currentPick, targetPick) are simulated. */
  targetPick: number;
  teams: number;
  players: SimPlayer[];
  simulations: number;
  seed: number;
  /** Optional: picks (overall number) in [currentPick, targetPick) that belong to the user and must NOT be simulated as opponents. */
  skipPicks?: number[];
  /** Fitted opponent-model parameters (see engine/analysis/fit); absent = defaults (k 1, autopickShare 0). */
  model?: OpponentModelParams;
}

/** k scales every player's ADP sigma; autopickShare = probability that an opponent pick simply takes the best remaining by ADP. */
export interface OpponentModelParams {
  k: number;
  autopickShare: number;
}

export interface SimulationResult {
  /** playerId → P(player still available at targetPick). */
  survival: Record<string, number>;
  simulations: number;
  picksSimulated: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------- recommendation

export type RecommendationState = "DRAFT" | "TAKE" | "WAIT" | "RISKY WAIT" | "AVOID";
export type RiskLabel = "Low" | "Medium" | "High";

export interface PlayerScore {
  playerId: string;
  /** All dimension scores normalized to 0–100 for display. */
  nineCat: number;
  rosterFit: number;
  vorp: number;
  scarcity: number;
  adpValue: number;
  flexibility: number;
  riskScore: number;
  riskLabel: RiskLabel;
  riskPenalty: number;
  /** Weighted score before risk. */
  draftScore: number;
  /** draftScore - riskPenalty. */
  riskAdjusted: number;
  /** P(available at our next pick); null when not computed / no next pick. */
  survival: number | null;
  urgency: number;
  recommendation: RecommendationState;
  reason: string;
  /** Standings dimension 0-100 (engine/standings-opt); present when a standings analysis fed the score. */
  roto?: number;
  /** Candidate's objective gain vs the baseline finish and the change of weekly matchup win probability (fraction, e.g. 0.012). */
  rotoGain?: number;
  dWinProb?: number;
  /** True when scored as an IL stash (late pick, free IL slot, injured with a known return): value scaled by season share. */
  ilStash?: boolean;
}
