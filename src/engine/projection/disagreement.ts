import type { CategoryScores, PlayerRecord } from "@/types";
import { CATEGORIES } from "@/types";
import { computeValuations } from "../valuation/value";
import { MIN_ACTUAL_GP, projectionSide, recordsFromSource } from "./blend";

/**
 * Round-aware handling of projection-vs-real DISAGREEMENT.
 *
 * Per player we have two 9-cat z vectors: z_proj (the projection side: Yahoo or Yahoo+FantasyPros) and z_real (2025-26 actual),
 * each standardized within its own source's top-N pool (`sourceZ`). The disagreement
 *
 *     d = (1/3) · Σ_c e_c · |z_proj,c - z_real,c|          (e_c = category emphasis, punted categories drop out)
 *
 * is the L1 distance of the two category profiles, divided by 3 (so a player the sources differ on by 1 SD in every category
 * has d = 3, by 1 SD in one category d = 0.33). It sees profile changes the old |Σz_proj - Σz_real| missed (a source that
 * trades PTS for AST is "the same player" by total but not by build).
 *
 * How the value adjusts depends on how early the pick is (the cost of being wrong is highest early, upside is what late picks buy):
 *   rounds 1..EARLY_MAX_ROUND   penalty:  value = blend - lambda · d
 *   rounds LATE_MIN_ROUND..     upside:   value = max(blend, 0.5·blend + 0.5·max(z_proj, z_real))   (sums, under the emphasis)
 *   in between                  linear interpolation of the two values by round.
 */
export const EARLY_MAX_ROUND = 6;
export const LATE_MIN_ROUND = 10;
/** Penalty per unit d in the early rounds (z-sum units). Calibrated on the 2026-27 board: median d 0.57 (top 100) -> 0.23 z, p90 0.92 -> 0.37 z, max 1.4 -> 0.55 z. */
export const AUTO_LAMBDA = 0.4;

export interface SourceZ {
  proj: CategoryScores;
  real: CategoryScores;
}

/** z vectors of both sources per player; players missing either source (or with < MIN_ACTUAL_GP real games) are absent (= no evidence). */
export function sourceZ(records: PlayerRecord[]): Record<string, SourceZ> {
  const out: Record<string, SourceZ> = {};
  if (!records.some((r) => r.projection.components && projectionSide(r.projection.components) && r.projection.components.actual)) return out;
  const y = computeValuations(recordsFromSource(records, "yahoo")).valuations;
  const a = computeValuations(recordsFromSource(records, "actual")).valuations;
  for (const r of records) {
    const c = r.projection.components;
    const id = r.player.id;
    if (!c || !projectionSide(c) || !c.actual || c.actual.games < MIN_ACTUAL_GP || !y[id] || !a[id]) continue;
    out[id] = { proj: y[id].z, real: a[id].z };
  }
  return out;
}

/** d (see module doc). `emphasis` defaults to all ones. */
export function lineDistance(s: SourceZ, emphasis?: CategoryScores): number {
  let t = 0;
  for (const c of CATEGORIES) t += (emphasis ? emphasis[c] : 1) * Math.abs(s.proj[c] - s.real[c]);
  return t / 3;
}

const weighted = (z: CategoryScores, emphasis?: CategoryScores) => CATEGORIES.reduce((a, c) => a + z[c] * (emphasis ? emphasis[c] : 1), 0);

/** 0 in rounds <= EARLY_MAX_ROUND, 1 in rounds >= LATE_MIN_ROUND, linear in between. */
export function lateness(round: number): number {
  if (round <= EARLY_MAX_ROUND) return 0;
  if (round >= LATE_MIN_ROUND) return 1;
  return (round - EARLY_MAX_ROUND) / (LATE_MIN_ROUND - EARLY_MAX_ROUND);
}

/** The round-aware value of a player whose blended (emphasis-weighted) value is `blend`. */
export function roundAwareValue(o: { blend: number; src: SourceZ | undefined; round: number; lambda?: number; emphasis?: CategoryScores }): number {
  if (!o.src) return o.blend;
  const lambda = o.lambda ?? AUTO_LAMBDA;
  const t = lateness(o.round);
  const early = o.blend - lambda * lineDistance(o.src, o.emphasis);
  if (t === 0) return early;
  const hi = Math.max(weighted(o.src.proj, o.emphasis), weighted(o.src.real, o.emphasis));
  const late = Math.max(o.blend, 0.5 * o.blend + 0.5 * hi);
  return t === 1 ? late : (1 - t) * early + t * late;
}
