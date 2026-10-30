import type { Category, CategoryScores, Strategy, StrategyPreset } from "@/types";
import { CATEGORIES } from "@/types";
import { leagueConfig } from "@/config/default-league";
import { needWeights } from "../roster/needs";
import { DEFAULT_PROJECTION_WEIGHT, normalizeProjectionWeight } from "../projection/blend";
import { DEFAULT_OBJECTIVE_MODE, OBJECTIVE_MODES, type ObjectiveMode } from "../standings-opt/objective";
import { TO_EMPHASIS, type ValuationOptions } from "../valuation/value";

export type { Strategy, StrategyPreset } from "@/types";

export const STRATEGY_PRESETS: readonly StrategyPreset[] = [
  "balanced", "punt-ft", "punt-fg", "punt-to", "punt-ast", "punt-3pm", "punt-pts", "custom",
];

const ones = (): CategoryScores => Object.fromEntries(CATEGORIES.map((c) => [c, 1])) as CategoryScores;

/**
 * Category emphasis per preset (multiplier on that category's contribution; 0 = punted, i.e. ignored entirely).
 * A punt preset zeroes one category and nudges the categories a build around that punt tends to win:
 *  - punt-ft:  FT% 0, FG% 1.15, REB 1.1, BLK 1.1   (bigs: bad free-throw shooters, strong inside)
 *  - punt-fg:  FG% 0, 3PM 1.15, FT% 1.1            (guards/shooters)
 *  - punt-to:  TO 0, AST 1.15, PTS 1.1             (high-usage creators)
 *  - punt-ast: AST 0, TO 0.7, BLK 1.1, REB 1.1     (bigs; fewer playmakers also means fewer turnovers)
 *  - punt-3pm: 3PM 0, FG% 1.1, REB 1.1, BLK 1.1
 *  - punt-pts: PTS 0, STL 1.1, AST 1.1
 * Everything not listed stays 1. "custom" uses the user-supplied categoryEmphasis.
 */
export const PRESET_EMPHASIS: Record<Exclude<StrategyPreset, "custom">, Partial<CategoryScores>> = {
  balanced: {},
  "punt-ft": { "FT%": 0, "FG%": 1.15, REB: 1.1, BLK: 1.1 },
  "punt-fg": { "FG%": 0, "3PM": 1.15, "FT%": 1.1 },
  "punt-to": { TO: 0, AST: 1.15, PTS: 1.1 },
  "punt-ast": { AST: 0, TO: 0.7, BLK: 1.1, REB: 1.1 },
  "punt-3pm": { "3PM": 0, "FG%": 1.1, REB: 1.1, BLK: 1.1 },
  "punt-pts": { PTS: 0, STL: 1.1, AST: 1.1 },
};

/** Risk presets: riskTolerance values (higher = injury risk penalized more). Conservative is the league default. */
export const RISK_PRESETS = { conservative: 0.3, balanced: 0.15, aggressive: 0.05 } as const;
export type RiskPreset = keyof typeof RISK_PRESETS;
export const DEFAULT_RISK_TOLERANCE: number = leagueConfig.riskTolerance;

export function presetEmphasis(preset: StrategyPreset, custom?: Partial<CategoryScores>): CategoryScores {
  const base = preset === "custom" ? (custom ?? {}) : PRESET_EMPHASIS[preset] ?? {};
  return { ...ones(), ...base };
}

/**
 * Robustness (consistency penalty): lambda per unit of Yahoo-vs-2025-26 disagreement, used by the "always" mode. The default
 * mode is "auto" (round-aware, engine/projection/disagreement.ts); "never" switches the adjustment off.
 */
export const MAX_ROBUSTNESS = 1;
export const ROBUSTNESS_ON = 0.25;
const normalizeRobustness = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? Math.min(MAX_ROBUSTNESS, Math.max(0, x)) : 0);
export const ROBUSTNESS_MODES = ["auto", "always", "never"] as const;
export type RobustnessMode = (typeof ROBUSTNESS_MODES)[number];
export const PROJECTION_MODES = ["auto", "fixed"] as const;
export type ProjectionMode = (typeof PROJECTION_MODES)[number];

/** Absent mode: "fixed" only when a non-default weight was saved (an older draft where the user picked a Mix), else "auto". */
export const projectionModeOf = (s?: Strategy | null): ProjectionMode =>
  s?.projectionMode ?? (s?.projectionWeight !== undefined && normalizeProjectionWeight(s.projectionWeight) !== DEFAULT_PROJECTION_WEIGHT ? "fixed" : "auto");
/** Absent mode: "always" for an older draft that had the Robust checkbox on, else "auto". */
export const robustnessModeOf = (s?: Strategy | null): RobustnessMode => s?.robustnessMode ?? (normalizeRobustness(s?.robustness) > 0 ? "always" : "auto");

export function makeStrategy(
  preset: StrategyPreset = "balanced",
  riskTolerance: number = DEFAULT_RISK_TOLERANCE,
  custom?: Partial<CategoryScores>,
  extras: { projectionWeight?: number; projectionMode?: ProjectionMode; robustness?: number; robustnessMode?: RobustnessMode; objective?: ObjectiveMode } = {},
): Strategy {
  const projectionWeight = normalizeProjectionWeight(extras.projectionWeight ?? DEFAULT_PROJECTION_WEIGHT);
  const projectionMode = extras.projectionMode ?? projectionModeOf({ projectionWeight } as Strategy);
  const robustnessMode = extras.robustnessMode ?? robustnessModeOf({ robustness: extras.robustness } as Strategy);
  const lambda = normalizeRobustness(extras.robustness);
  return {
    preset,
    riskTolerance: clamp01(riskTolerance),
    categoryEmphasis: presetEmphasis(preset, custom),
    projectionWeight,
    projectionMode,
    robustnessMode,
    ...(extras.objective && extras.objective !== DEFAULT_OBJECTIVE_MODE ? { objective: extras.objective } : {}),
    ...(robustnessMode === "always" ? { robustness: lambda > 0 ? lambda : ROBUSTNESS_ON } : {}),
  };
}

/** The strategy's fixed Yahoo projection weight (default when absent, e.g. drafts saved before the blend existed). Only used in "fixed" mode. */
export const projectionWeightOf = (s?: Strategy | null): number => normalizeProjectionWeight(s?.projectionWeight ?? DEFAULT_PROJECTION_WEIGHT);
/** What applyProjectionBlend takes: "auto" (per-player rate/volume split) or the fixed weight. */
export const projectionSpecOf = (s?: Strategy | null): number | "auto" => (projectionModeOf(s) === "auto" ? "auto" : projectionWeightOf(s));
/** Lambda of the "always" mode (0 in the other modes). */
export const robustnessOf = (s?: Strategy | null): number => (robustnessModeOf(s) === "always" ? normalizeRobustness(s?.robustness) || ROBUSTNESS_ON : 0);

/** The standings objective of a strategy (absent = "h2h"). */
export const objectiveModeOf = (s?: Strategy | null): ObjectiveMode => (OBJECTIVE_MODES.includes(s?.objective as ObjectiveMode) ? (s!.objective as ObjectiveMode) : DEFAULT_OBJECTIVE_MODE);
/** Valuation options of a strategy: every objective but "classic" uses the usage-neutral TO z (see valuation/value.ts). */
export const valuationOptionsOf = (s?: Strategy | null): ValuationOptions => (objectiveModeOf(s) === "classic" ? {} : { usageAdjustTO: true, toEmphasis: TO_EMPHASIS });

export const defaultStrategy = (): Strategy => makeStrategy("balanced", DEFAULT_RISK_TOLERANCE);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface StrategyPatch {
  preset?: StrategyPreset;
  riskTolerance?: number;
  categoryEmphasis?: Partial<CategoryScores>;
  /** 0..1 Yahoo share of the fixed projection blend; setting it selects the "fixed" mode. Independent of the preset. */
  projectionWeight?: number;
  /** "auto" = per-player rate/volume weights, "fixed" = projectionWeight. */
  projectionMode?: ProjectionMode;
  /** > 0 consistency-penalty lambda (selects the "always" mode); 0 selects "never". Independent of the preset. */
  robustness?: number;
  robustnessMode?: RobustnessMode;
  /** Standings objective (see objectiveModeOf). */
  objective?: ObjectiveMode;
}

/**
 * Apply a partial update. A non-custom preset always resets the emphasis to the preset's; supplying only
 * categoryEmphasis switches to "custom" (missing categories keep their current multiplier); preset "custom" with no
 * categoryEmphasis keeps the current multipliers.
 */
export function applyStrategyPatch(current: Strategy, patch: StrategyPatch): Strategy {
  const risk = patch.riskTolerance ?? current.riskTolerance;
  const preset = patch.preset ?? (patch.categoryEmphasis ? "custom" : current.preset);
  const extras = {
    projectionWeight: patch.projectionWeight ?? current.projectionWeight,
    projectionMode: patch.projectionMode ?? (patch.projectionWeight !== undefined ? ("fixed" as const) : projectionModeOf(current)),
    robustness: patch.robustness ?? current.robustness,
    objective: patch.objective ?? objectiveModeOf(current),
    robustnessMode: patch.robustnessMode ?? (patch.robustness !== undefined ? (patch.robustness > 0 ? ("always" as const) : ("never" as const)) : robustnessModeOf(current)),
  };
  if (preset !== "custom") return makeStrategy(preset, risk, undefined, extras);
  return makeStrategy("custom", risk, { ...current.categoryEmphasis, ...(patch.categoryEmphasis ?? {}) }, extras);
}

/** Parse a stored/untrusted JSON value into a valid Strategy; anything unusable -> default. */
export function parseStrategy(raw: unknown): Strategy {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return defaultStrategy(); }
  }
  if (!v || typeof v !== "object") return defaultStrategy();
  const o = v as Record<string, unknown>;
  const preset = STRATEGY_PRESETS.includes(o.preset as StrategyPreset) ? (o.preset as StrategyPreset) : "balanced";
  const risk = typeof o.riskTolerance === "number" && Number.isFinite(o.riskTolerance) ? o.riskTolerance : DEFAULT_RISK_TOLERANCE;
  const custom: Partial<CategoryScores> = {};
  if (o.categoryEmphasis && typeof o.categoryEmphasis === "object") {
    for (const c of CATEGORIES) {
      const x = (o.categoryEmphasis as Record<string, unknown>)[c];
      if (typeof x === "number" && Number.isFinite(x) && x >= 0) custom[c] = x;
    }
  }
  const pm = PROJECTION_MODES.includes(o.projectionMode as ProjectionMode) ? (o.projectionMode as ProjectionMode) : undefined;
  const rm = ROBUSTNESS_MODES.includes(o.robustnessMode as RobustnessMode) ? (o.robustnessMode as RobustnessMode) : undefined;
  return makeStrategy(preset, risk, custom, {
    projectionWeight: typeof o.projectionWeight === "number" ? o.projectionWeight : undefined,
    projectionMode: pm,
    robustness: typeof o.robustness === "number" ? o.robustness : undefined,
    robustnessMode: rm,
    objective: OBJECTIVE_MODES.includes(o.objective as ObjectiveMode) ? (o.objective as ObjectiveMode) : undefined,
  });
}

export const puntedCategories = (s?: Strategy | null): Category[] =>
  s ? CATEGORIES.filter((c) => s.categoryEmphasis[c] <= 0) : [];

/** True when the strategy changes nothing relative to no strategy (balanced emphasis, config risk). */
export function isNeutralStrategy(s?: Strategy | null): boolean {
  return !s || (CATEGORIES.every((c) => s.categoryEmphasis[c] === 1) && s.riskTolerance === DEFAULT_RISK_TOLERANCE);
}

/** Stable string for memoization keys. */
export function strategyKey(s?: Strategy | null): string {
  const t = s ?? defaultStrategy();
  return `${t.preset}|${t.riskTolerance}|${CATEGORIES.map((c) => t.categoryEmphasis[c]).join(",")}|p${projectionModeOf(t) === "auto" ? "auto" : projectionWeightOf(t)}|r${robustnessModeOf(t)}${robustnessOf(t)}|o${objectiveModeOf(t)}`;
}

/** Closest named risk preset to a riskTolerance (for UI labels). */
export function riskPresetOf(riskTolerance: number): { name: RiskPreset; exact: boolean } {
  let best: RiskPreset = "conservative";
  let d = Infinity;
  for (const [k, v] of Object.entries(RISK_PRESETS) as [RiskPreset, number][]) {
    const dd = Math.abs(v - riskTolerance);
    if (dd < d) { d = dd; best = k; }
  }
  return { name: best, exact: d < 1e-9 };
}

/** "FT%" -> "FT", for "punt-FT" style labels. */
export const puntName = (c: Category) => c.replace("%", "");

/**
 * Final per-category weights used for roster fit: need weight (punted categories ignored = 0) x emphasis.
 * With no strategy this equals needWeights().
 */
export function effectiveNeedWeights(
  profile: CategoryScores,
  rosterSize: number,
  strategy?: Strategy | null,
  bounds: { min: number; max: number } = leagueConfig.needWeightBounds,
): CategoryScores {
  const e = strategy?.categoryEmphasis;
  const nw = needWeights(profile, rosterSize, bounds, e);
  if (!e) return nw;
  const out = { ...nw };
  for (const c of CATEGORIES) out[c] = nw[c] * e[c];
  return out;
}
