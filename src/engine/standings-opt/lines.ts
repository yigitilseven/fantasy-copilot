import type { PlayerRecord } from "@/types";
import { totalsOf, type RotoCategory, type TotalsLine } from "../evaluation/standings";

/**
 * Per-view stat lines of a player for the standings optimizer.
 *
 * The three Yahoo views the user is judged on:
 *  - proj:  Yahoo 2026-27 projected SEASON TOTALS (per game x projected games). Players Yahoo shows no projection for contribute
 *           nothing (exactly what the evaluator / Yahoo do) unless `fallbackProj` is set, in which case the record's own projection
 *           (the blended / NBA.com line) x games stands in.
 *  - total: real 2025-26 SEASON TOTALS (per game x GP). No 2025-26 line (rookie) = nothing, like Yahoo.
 *  - avg:   real 2025-26 PER-GAME averages, summed over the roster (Yahoo's "Average Stats" view sums them).
 * FG% / FT% in every view are Σmakes/Σattempts of the lines (per-game makes/attempts in "avg").
 */
export const OPT_VIEWS = ["proj", "total", "avg"] as const;
export type OptView = (typeof OPT_VIEWS)[number];
export const VIEW_LABELS: Record<OptView, string> = { proj: "Proj", total: "Total", avg: "Avg" };
export const VIEW_COUNT = OPT_VIEWS.length;

/** Field order of the packed lines (matches TotalsLine). */
export const FIELDS = ["fgm", "fga", "ftm", "fta", "threePm", "pts", "reb", "ast", "stl", "blk", "tov"] as const;
export const NF = FIELDS.length;
export const F = { fgm: 0, fga: 1, ftm: 2, fta: 3, threePm: 4, pts: 5, reb: 6, ast: 7, stl: 8, blk: 9, tov: 10 } as const;

export interface LineOptions {
  /** proj view: use the record's own projection x games when Yahoo has no line for the player. Default false (Yahoo-exact). */
  fallbackProj?: boolean;
}

/** Packs per-view lines into one Float64Array of VIEW_COUNT * NF numbers (view-major). */
export function packTotals(lines: (TotalsLine | null)[]): Float64Array {
  const out = new Float64Array(VIEW_COUNT * NF);
  lines.forEach((l, v) => {
    if (!l) return;
    for (let f = 0; f < NF; f++) out[v * NF + f] = l[FIELDS[f]];
  });
  return out;
}

/** The three view lines of one record (see module doc). Records without `components` use their projection for every view. */
export function viewLinesOf(r: PlayerRecord, opts: LineOptions = {}): Float64Array {
  const c = r.projection.components;
  const own = (mode: "total" | "avg") => totalsOf(r.projection, mode);
  if (!c) return packTotals([own("total"), own("total"), own("avg")]);
  const proj = c.yahoo ? totalsOf(c.yahoo, "total") : opts.fallbackProj ? own("total") : null;
  return packTotals([proj, c.actual ? totalsOf(c.actual, "total") : null, c.actual ? totalsOf(c.actual, "avg") : null]);
}

/** Roto category name -> the app's category name ("ST" -> "STL", "3PTM" -> "3PM"). */
export const displayCat = (c: RotoCategory): string => (c === "ST" ? "STL" : c === "3PTM" ? "3PM" : c);
