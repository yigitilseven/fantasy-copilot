import type { BlendEvidence, PlayerRecord, Projection, ProjectionBlendInfo, ProjectionLine } from "@/types";
import { computeValuations } from "../valuation/value";
import { production } from "./backtest";

/**
 * Projection blend: a middle ground between Yahoo's forward-looking 2026-27 projection and real 2025-26 production.
 *
 *   line = w · Yahoo(2026-27)  +  (1 - w) · Actual(2025-26)        (per game, every field)
 *
 * - Every counting field AND the attempts/makes (FGM, FGA, FTM, FTA) are blended separately, so the blended FG% / FT% are
 *   Σmakes/Σattempts of the blended line (always consistent, a high-volume source weighs more in the percentage).
 * - Games: w · YahooGP + (1 - w) · availability estimate, where the estimate shrinks last season's GP toward a typical season
 *   (AVAILABILITY_SHRINK of the prior TYPICAL_GAMES): 0.7·GP25 + 0.3·68, clamped to 0..82. It only changes totals (evaluator),
 *   never the per-game valuation.
 * - Reliability: actual 2025-26 GP < MIN_ACTUAL_GP (injured season) or no actual line (rookie / no NBA.com stats) -> Yahoo only
 *   (effective w = 1); no Yahoo projection -> actual only (effective w = 0). With no Yahoo data at all, records pass through
 *   untouched (the existing 0.7/0.3 NBA.com line stays).
 * - w = 1 returns the records unchanged (the plain Yahoo overlay).
 *
 * v2 ("auto", the default): a PER-PLAYER rate/volume split instead of one global w. See the "Auto blend" section below and the
 * README ("Projection mix"). The fixed-weight functions above are unchanged and stay available as the override.
 *
 * The "Yahoo" side is the projection side of the record: average(Yahoo, FantasyPros) per stat when both exist, else whichever
 * exists (`components.projection`; absent = Yahoo).
 */
export const DEFAULT_PROJECTION_WEIGHT = 0.6;
export const PROJECTION_WEIGHT_OPTIONS = [0, 0.4, 0.6, 0.8, 1] as const;
export const MIN_ACTUAL_GP = 25;
export const TYPICAL_GAMES = 68;
export const AVAILABILITY_SHRINK = 0.3;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const normalizeProjectionWeight = (w: unknown): number =>
  typeof w === "number" && Number.isFinite(w) ? Math.round(clamp01(w) * 1000) / 1000 : DEFAULT_PROJECTION_WEIGHT;

/** Games expected from last season's availability (see module doc). */
export function availabilityGames(gp25: number): number {
  return Math.min(82, Math.max(0, (1 - AVAILABILITY_SHRINK) * gp25 + AVAILABILITY_SHRINK * TYPICAL_GAMES));
}

const FIELDS = ["minutes", "pts", "fgm", "fga", "ftm", "fta", "threePm", "reb", "ast", "stl", "blk", "tov"] as const;

export function mixLines(yahoo: ProjectionLine, actual: ProjectionLine, w: number): ProjectionLine {
  const out = { games: w * yahoo.games + (1 - w) * availabilityGames(actual.games) } as ProjectionLine;
  for (const f of FIELDS) out[f] = w * yahoo[f] + (1 - w) * actual[f];
  return out;
}

export function lineOf(p: Projection): ProjectionLine {
  return { games: p.games, minutes: p.minutes, pts: p.pts, fgm: p.fgm, fga: p.fga, ftm: p.ftm, fta: p.fta, threePm: p.threePm, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, tov: p.tov };
}

/** The effective weight for one player given what data exists (see module doc). */
export function effectiveWeight(w: number, yahoo: ProjectionLine | null, actual: ProjectionLine | null): { weight: number; reason?: ProjectionBlendInfo["reason"] } {
  if (!yahoo) return { weight: 0, reason: "no-yahoo" };
  if (!actual) return { weight: 1, reason: "no-actual" };
  if (actual.games < MIN_ACTUAL_GP) return { weight: 1, reason: "low-gp" };
  return { weight: w };
}

/** The blended per-game line for a player, or null when neither source exists. */
export function blendLines(yahoo: ProjectionLine | null, actual: ProjectionLine | null, w: number): { line: ProjectionLine; info: ProjectionBlendInfo } | null {
  const req = normalizeProjectionWeight(w);
  if (!yahoo && !actual) return null;
  // No projection AND a tiny real sample (e.g. a Yahoo-created placeholder matched to a namesake with a handful of games): no line at all.
  if (!yahoo && actual && actual.games < MIN_ACTUAL_GP) return null;
  const eff = effectiveWeight(req, yahoo, actual);
  const line = eff.weight >= 1 ? yahoo! : eff.weight <= 0 ? actual! : mixLines(yahoo!, actual!, eff.weight);
  return { line, info: { weight: req, effectiveWeight: eff.weight, ...(eff.reason ? { reason: eff.reason } : {}), yahoo, actual } };
}

/** Applies the blend to one record (needs `projection.components`; otherwise returned as is). */
export function blendRecord(r: PlayerRecord, w: number): PlayerRecord {
  const c = r.projection.components;
  if (!c) return r;
  const b = blendLines(projectionSide(c), c.actual, w);
  if (!b) return r;
  const eff = b.info.effectiveWeight;
  // Projection-only: keep the plain record (annotated with why a requested blend did not apply).
  if (eff >= 1) return b.info.reason ? { ...r, projection: { ...r.projection, blend: b.info } } : r;
  return {
    ...r,
    projection: { ...r.projection, ...b.line, playerId: r.projection.playerId, projectionSource: eff <= 0 ? "nba-stats" : "blend", blend: b.info },
  };
}

/** The forward-looking line of a record's components: the consensus when present, else Yahoo. */
export function projectionSide(c: { yahoo: ProjectionLine | null; projection?: ProjectionLine | null }): ProjectionLine | null {
  return c.projection !== undefined ? c.projection : c.yahoo;
}

/**
 * Blends every record. `weight` is a fixed Yahoo weight (v1) or "auto" (v2 per-player rate/volume split). No-op (same array)
 * when no record has a projection line or the fixed weight is 1.
 */
export function applyProjectionBlend(records: PlayerRecord[], weight: number | "auto"): PlayerRecord[] {
  if (!records.some((r) => r.projection.components && projectionSide(r.projection.components))) return records;
  if (weight === "auto") return records.map((r) => blendRecordAuto(r));
  const w = normalizeProjectionWeight(weight);
  if (w >= 1) return records;
  return records.map((r) => blendRecord(r, w));
}

/** Records re-expressed as a single source ("yahoo" = the projection side | "actual"); records without that source are dropped. */
export function recordsFromSource(records: PlayerRecord[], source: "yahoo" | "actual"): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  for (const r of records) {
    const c = r.projection.components;
    const line = source === "yahoo" ? (c ? projectionSide(c) : null) : c?.actual;
    if (line) out.push({ ...r, projection: { ...r.projection, ...line, playerId: r.projection.playerId } });
  }
  return out;
}

/**
 * |nineCat_yahoo - nineCat_actual| per player: how much the two sources disagree about his 9-cat value (z-scores are computed
 * per source over that source's own top-N pool). Players missing either source (or with low actual GP) get 0 — no evidence of
 * disagreement. Feeds the optional robustness penalty in scorePlayers.
 */
export function projectionDisagreement(records: PlayerRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!records.some((r) => r.projection.components && projectionSide(r.projection.components) && r.projection.components.actual)) return out;
  const y = computeValuations(recordsFromSource(records, "yahoo")).valuations;
  const a = computeValuations(recordsFromSource(records, "actual")).valuations;
  for (const r of records) {
    const c = r.projection.components;
    const id = r.player.id;
    if (!c || !projectionSide(c) || !c.actual || c.actual.games < MIN_ACTUAL_GP || !y[id] || !a[id]) continue;
    out[id] = Math.abs(y[id].nineCat - a[id].nineCat);
  }
  return out;
}

// =====================================================================================================================
// Auto blend (v2): per-player RATE / VOLUME split
// =====================================================================================================================
//
//   volume = games and minutes per game          -> mostly the projection (w_vol, default 0.80)
//   rates  = per-36-minute production            -> blended with a per-player w_rate (rules below)
//
//   rate  = w_rate · proj_per36 + (1 - w_rate) · real_per36        (PTS 3PM REB AST STL BLK TOV, and FGM FGA FTM FTA separately,
//                                                                    so FG% / FT% stay Σmakes/Σattempts)
//   min   = w_vol  · proj_min   + (1 - w_vol)  · MPG(real)
//   games = w_vol  · proj_games + (1 - w_vol)  · availabilityGames(GP 2025-26)
//   line  = rate · min / 36     (per game)
//
// Real per-36: 2025-26 rates; when that sample is small (< TARGET_SAMPLE_MINUTES) it is topped up with 2024-25 rates (weight
// PRIOR_SEASON_WEIGHT per minute, never more than the missing minutes), so a half-season sample leans on last year too.
//
// Projection minutes: Yahoo's table has NO minutes. We take an anchor that does have them (FantasyPros' MIN/GP when listed, else
// the player's real MPG) and scale it by the projection's production (NBA.com fantasy-points formula) relative to the anchor's,
// raised to MINUTES_ELASTICITY (backtest: 0.86 of a production change between seasons is a minutes change, r = 0.95):
//   proj_min = anchor_mpg · (prod_proj / prod_anchor)^0.86   clamped to [MIN_MPG, MAX_MPG]
// So "Yahoo projects him for +20% production" is read as mostly "+17% minutes", and only the remainder as a rate change.
// proj_per36 = proj_per_game · 36 / proj_min.
//
// Weights: playerBlendWeights() (rules from the agreed table, numbers calibrated by `pnpm blend:backtest`, see README):
//   lean-projection rules (take the max): rookie / age <= 23 / <= 2nd season, team change, role change, injury return, age 32+
//   stable veteran (>= 2 seasons GP >= 60, same team, age 24-31) -> 0.45;  otherwise 0.60.

/** Calibrated defaults (Yahoo/projection share). Evidence: tests/ + `pnpm blend:backtest`; README documents how they were set. */
export const DEFAULT_BLEND_WEIGHTS = {
  /** Rookie / age <= 23 / <= 2nd NBA season. Agreed 0.85, backtest 0.61 -> 0.75. */
  young: 0.75,
  /** Team change or implied role change (|projected MPG - real MPG| >= ROLE_CHANGE_MPG). Agreed 0.80, backtest 0.63 -> 0.70. */
  change: 0.7,
  /** Injury return (GP < INJURY_RETURN_GP last season). Agreed 0.80, backtest 0.68 -> 0.75; volume 0.90 / 0.82 -> 0.85. */
  injury: 0.75,
  injuryVol: 0.85,
  /** Age >= 32. Agreed 0.70, backtest 0.61 -> 0.65. */
  age32: 0.65,
  /** Stable veteran. Agreed 0.40, backtest 0.52 -> 0.45. */
  vet: 0.45,
  /** Everyone else. Agreed 0.60, backtest 0.61 -> 0.60. */
  base: 0.6,
  /** Volume (games, minutes) for everyone but injury returners. Agreed 0.80, backtest 0.75-0.85 -> 0.80. */
  vol: 0.8,
} as const;
export type BlendWeightTable = { [K in keyof typeof DEFAULT_BLEND_WEIGHTS]: number };

export const YOUNG_MAX_AGE = 23;
export const VET_MIN_AGE = 24;
export const VET_MAX_AGE = 31;
export const OLD_MIN_AGE = 32;
export const INJURY_RETURN_GP = 40;
export const STABLE_GP = 60;
export const ROLE_CHANGE_MPG = 5;
/** Share of the real-vs-projection per-36 difference the sample size must carry before 2024-25 stops being used. */
export const TARGET_SAMPLE_MINUTES = 1500;
export const PRIOR_SEASON_WEIGHT = 0.5;
/** d ln(minutes) / d ln(production) between consecutive seasons (backtest 2024-25 -> 2025-26: 0.858). */
export const MINUTES_ELASTICITY = 0.85;
export const MIN_MPG = 8;
export const MAX_MPG = 40;

const TEAM_ALIASES: Record<string, string> = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", PHO: "PHX", WSH: "WAS", UTAH: "UTA", UTH: "UTA", BRK: "BKN", CHO: "CHA", NOR: "NOP" };
export function canonicalTeam(t: string | null | undefined): string | null {
  if (!t) return null;
  const up = t.trim().toUpperCase();
  if (!up || up === "FA") return null;
  return TEAM_ALIASES[up] ?? up;
}

export interface WeightPlayer {
  /** Age in the projected 2026-27 season (NBA.com convention). */
  age: number;
  /** 2026-27 team. */
  team: string | null;
  /** First NBA season start year (2025 = rookie in 2025-26); null/undefined = unknown. */
  fromYear?: number | null;
}
export interface SeasonSample {
  line: ProjectionLine;
  team: string | null;
}
export interface ProjectionSample {
  /** Projection-side per-game line. */
  line: ProjectionLine;
  /** Minutes per game assumed for it (see impliedMinutes). */
  minutes: number;
}
export interface BlendWeights {
  wRate: number;
  wVol: number;
  /** Rules that applied, strongest first ("rookie / young (age 21)", ...). reasons[0] is what the UI headlines. */
  reasons: string[];
}

/**
 * Per-player rate / volume weights (Yahoo/projection share). Pure.
 * Lean-projection rules combine as the MAX; the stable-veteran rule only applies when none of them does.
 */
export function playerBlendWeights(
  player: WeightPlayer,
  stats25: SeasonSample | null,
  stats24: SeasonSample | null,
  yahoo: ProjectionSample | null,
  table: BlendWeightTable = DEFAULT_BLEND_WEIGHTS,
): BlendWeights {
  const lean: { w: number; reason: string }[] = [];
  let wVol: number = table.vol;
  const t26 = canonicalTeam(player.team);
  const t25 = canonicalTeam(stats25?.team);
  const t24 = canonicalTeam(stats24?.team);
  const gp25 = stats25?.line.games ?? 0;

  const secondYear = player.fromYear != null ? player.fromYear >= 2025 : stats24 === null && stats25 !== null;
  if (player.age <= YOUNG_MAX_AGE || secondYear || (stats25 === null && stats24 === null)) {
    const why = stats25 === null && stats24 === null ? "rookie" : player.age <= YOUNG_MAX_AGE ? `young (age ${player.age})` : "2nd-year player";
    lean.push({ w: table.young, reason: why });
  }
  if (t26 && t25 && t26 !== t25) lean.push({ w: table.change, reason: `team change ${t25} to ${t26}` });
  const realMpg = (stats25 && stats25.line.games >= MIN_ACTUAL_GP ? stats25 : stats24)?.line.minutes;
  if (yahoo && realMpg && Math.abs(yahoo.minutes - realMpg) >= ROLE_CHANGE_MPG)
    lean.push({ w: table.change, reason: `role change (${yahoo.minutes >= realMpg ? "+" : ""}${(yahoo.minutes - realMpg).toFixed(1)} MPG projected)` });
  if (stats25 === null ? stats24 !== null : gp25 < INJURY_RETURN_GP) {
    lean.push({ w: table.injury, reason: `injury return (${Math.round(gp25)} GP in 2025-26)` });
    wVol = Math.max(wVol, table.injuryVol);
  }
  if (player.age >= OLD_MIN_AGE) lean.push({ w: table.age32, reason: `age ${player.age}` });

  if (lean.length) {
    lean.sort((a, b) => b.w - a.w);
    return { wRate: Math.max(...lean.map((x) => x.w)), wVol, reasons: lean.map((x) => x.reason) };
  }
  const stable =
    gp25 >= STABLE_GP && (stats24?.line.games ?? 0) >= STABLE_GP && player.age >= VET_MIN_AGE && player.age <= VET_MAX_AGE &&
    (!t26 || !t25 || t26 === t25) && (!t25 || !t24 || t25 === t24);
  if (stable) return { wRate: table.vet, wVol, reasons: ["stable veteran (2 seasons of 60+ GP, same team)"] };
  return { wRate: table.base, wVol, reasons: ["default"] };
}

/** Production scalar (NBA.com fantasy points). */
export const productionOf = production;

/** Minutes per game for a projection line that has no minutes (see the section doc). */
export function impliedMinutes(proj: ProjectionLine, anchor: { mpg: number; line: ProjectionLine }): number {
  const pa = production(anchor.line);
  const pp = production(proj);
  if (!(anchor.mpg > 0)) return Math.min(MAX_MPG, Math.max(MIN_MPG, 24));
  if (!(pa > 1)) return anchor.mpg;
  if (!(pp > 0)) return MIN_MPG;
  return Math.min(MAX_MPG, Math.max(MIN_MPG, anchor.mpg * (pp / pa) ** MINUTES_ELASTICITY));
}

const RATE_FIELDS = ["pts", "fgm", "fga", "ftm", "fta", "threePm", "reb", "ast", "stl", "blk", "tov"] as const;
export type Per36 = Record<(typeof RATE_FIELDS)[number], number>;

export function per36Of(line: ProjectionLine, minutes: number = line.minutes): Per36 {
  const k = minutes > 0 ? 36 / minutes : 0;
  const out = {} as Per36;
  for (const f of RATE_FIELDS) out[f] = line[f] * k;
  return out;
}

/** Real per-36 rates: 2025-26, topped up with 2024-25 when the 2025-26 sample is small (see the section doc). Null = no usable sample. */
export function realRates(l25: ProjectionLine | null, l24: ProjectionLine | null): Per36 | null {
  const ok = (l: ProjectionLine | null): l is ProjectionLine => !!l && l.games > 0 && l.minutes > 0;
  const a = ok(l25) ? l25 : null;
  const b = ok(l24) ? l24 : null;
  if (!a && !b) return null;
  const ma = a ? a.games * a.minutes : 0;
  const mb = b ? b.games * b.minutes : 0;
  const wa = ma;
  const wb = !b ? 0 : !a ? mb : Math.min(PRIOR_SEASON_WEIGHT * mb, Math.max(0, TARGET_SAMPLE_MINUTES - ma));
  const tot = wa + wb;
  if (!(tot > 0)) return per36Of(a ?? b!);
  const ra = a ? per36Of(a) : null;
  const rb = b ? per36Of(b) : null;
  const out = {} as Per36;
  for (const f of RATE_FIELDS) out[f] = ((ra ? ra[f] * wa : 0) + (rb ? rb[f] * wb : 0)) / tot;
  return out;
}

export interface AutoBlendContext {
  proj: ProjectionLine | null;
  /** FantasyPros line, used as the minutes anchor when listed. */
  fantasyPros?: ProjectionLine | null;
  actual: ProjectionLine | null;
  actualPrev?: ProjectionLine | null;
  evidence: BlendEvidence;
}

/** Auto blend of one player's lines, or null when there is nothing to blend (the caller keeps the plain record). */
export function blendAuto(c: AutoBlendContext, table: BlendWeightTable = DEFAULT_BLEND_WEIGHTS): { line: ProjectionLine; info: ProjectionBlendInfo } | null {
  const { proj, actual, actualPrev } = c;
  const l25 = actual && actual.games > 0 ? actual : null;
  const l24 = actualPrev && actualPrev.games > 0 ? actualPrev : null;
  if (!proj && !l25) return null;
  if (!proj && l25!.games < MIN_ACTUAL_GP) return null; // see blendLines
  const base25 = l25 && l25.games >= MIN_ACTUAL_GP ? l25 : null;
  const base24 = l24 && l24.games >= MIN_ACTUAL_GP ? l24 : null;
  // A real line without minutes (stats cache missing) has no usable rates: treat it like no real sample.
  const real = realRates(l25, l24);
  const hasMin = (l: ProjectionLine | null) => (l && l.minutes > 0 ? l : null);
  const realBase = real ? (hasMin(base25) ?? hasMin(base24)) : null;
  const info = (extra: Partial<ProjectionBlendInfo>): ProjectionBlendInfo => ({ weight: 0, effectiveWeight: 0, mode: "auto", yahoo: proj, actual, ...extra });
  if (!proj) return { line: l25!, info: info({ reason: "no-yahoo", reasons: ["no projection: 2025-26 actual only"] }) };
  if (!realBase || !real) {
    return { line: proj, info: info({ weight: 1, effectiveWeight: 1, wRate: 1, wVol: 1, reason: l25 ? "low-gp" : "no-actual", reasons: [l25 ? "few real games: projection only" : "no real NBA stats (rookie): projection only"] }) };
  }

  const fp = c.fantasyPros && c.fantasyPros.minutes > 0 && c.fantasyPros.games > 0 ? c.fantasyPros : null;
  const anchor = fp ? { mpg: fp.minutes, line: fp } : { mpg: realBase.minutes, line: realBase };
  const yMin = impliedMinutes(proj, anchor);
  const ev = c.evidence;
  const w = playerBlendWeights(
    { age: ev.age, team: ev.team26, fromYear: ev.fromYear },
    l25 ? { line: l25, team: ev.team25 } : null,
    l24 ? { line: l24, team: ev.team24 } : null,
    { line: proj, minutes: yMin },
    table,
  );
  const pRate = per36Of(proj, yMin);
  const minutes = w.wVol * yMin + (1 - w.wVol) * realBase.minutes;
  const games = w.wVol * proj.games + (1 - w.wVol) * availabilityGames(l25?.games ?? 0);
  const line = { games, minutes } as ProjectionLine;
  for (const f of RATE_FIELDS) line[f] = (w.wRate * pRate[f] + (1 - w.wRate) * real[f]) * (minutes / 36);
  return { line, info: info({ weight: w.wRate, effectiveWeight: w.wRate, wRate: w.wRate, wVol: w.wVol, reasons: w.reasons, yahooMinutes: yMin }) };
}

/** Auto-blends one record (needs `projection.components`; otherwise returned as is). */
export function blendRecordAuto(r: PlayerRecord, table: BlendWeightTable = DEFAULT_BLEND_WEIGHTS): PlayerRecord {
  const c = r.projection.components;
  if (!c) return r;
  const ev: BlendEvidence = c.evidence ?? { age: r.player.age + 1, team26: r.player.nbaTeam, team25: null, team24: null, fromYear: null };
  const b = blendAuto({ proj: projectionSide(c), fantasyPros: c.fantasyPros, actual: c.actual, actualPrev: c.actualPrev, evidence: ev }, table);
  if (!b) return r;
  if (b.info.effectiveWeight >= 1) {
    // Projection only. The record already is the plain Yahoo line unless the projection side is a consensus (Yahoo + FantasyPros, or FantasyPros alone).
    const consensus = !!c.projection && c.projection !== c.yahoo;
    return consensus
      ? { ...r, projection: { ...r.projection, ...b.line, playerId: r.projection.playerId, projectionSource: "consensus-2026-27", blend: b.info } }
      : { ...r, projection: { ...r.projection, blend: b.info } };
  }
  return { ...r, projection: { ...r.projection, ...b.line, playerId: r.projection.playerId, projectionSource: b.info.effectiveWeight <= 0 ? "nba-stats" : "blend", blend: b.info } };
}

/** The blended per-game line of a record under a fixed weight or "auto"; null when neither source exists. Used by the evaluator. */
export function blendedLineOf(r: PlayerRecord | undefined, spec: number | "auto"): { line: ProjectionLine; info: ProjectionBlendInfo } | null {
  const c = r?.projection.components;
  if (!r || !c) return null;
  if (spec === "auto") {
    const ev: BlendEvidence = c.evidence ?? { age: r.player.age + 1, team26: r.player.nbaTeam, team25: null, team24: null, fromYear: null };
    return blendAuto({ proj: projectionSide(c), fantasyPros: c.fantasyPros, actual: c.actual, actualPrev: c.actualPrev, evidence: ev });
  }
  return blendLines(projectionSide(c), c.actual, spec);
}
