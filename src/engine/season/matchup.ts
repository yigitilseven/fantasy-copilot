import { CAT_CV, PCT_INFLATION, SCHEDULE_CV, winAtLeast } from "../standings-opt/h2h";
import { phi } from "../standings-opt/phi";
import { NS, S } from "./projection";
import { SEASON_CATS, type StatVec } from "./types";

/** Mean / sd of a team's 9 category values over a fantasy week (or the rest of it). */
export interface Dist {
  mean: number[];
  sd: number[];
}

export interface WindowTotals {
  /** Expected stat totals over the window (11-vector). */
  totals: StatVec;
  /** Expected player-games in the window; noise shrinks like 1/sqrt(this). */
  playerGames: number;
}

/**
 * Category distribution of a matchup week: `cur` = totals already banked this week (from the Yahoo matchup page; null = week not started),
 * `rem` = projection of the rest. Same noise model as engine/standings-opt/h2h.ts (documented there): counting stats
 * sd = remMean * sqrt(cv^2 / playerGames + SCHEDULE_CV^2); percentages sd = sqrt(rem attempts * p(1-p)) * 1.25 / total attempts.
 * Only the remaining part is uncertain, so a category that is already decided tends to P ~ 0/1.
 */
export function distOf(cur: StatVec | null, rem: WindowTotals): Dist {
  const c = cur ?? new Array<number>(NS).fill(0);
  const t = rem.totals;
  const mean = new Array<number>(9).fill(0);
  const sd = new Array<number>(9).fill(0);
  const G = Math.max(1, rem.playerGames);
  const pct = (m: number, a: number, remA: number, i: number) => {
    const att = c[a] + t[a];
    const p = att > 0 ? (c[m] + t[m]) / att : 0;
    mean[i] = p;
    sd[i] = att > 0 ? (Math.sqrt(Math.max(0, remA) * p * (1 - p)) * PCT_INFLATION) / att : 0;
  };
  pct(S.fgm, S.fga, t[S.fga], 0);
  pct(S.ftm, S.fta, t[S.fta], 1);
  const counting: [number, number][] = [[2, S.threePm], [3, S.pts], [4, S.reb], [5, S.ast], [6, S.stl], [7, S.blk], [8, S.tov]];
  for (const [i, f] of counting) {
    mean[i] = c[f] + t[f];
    sd[i] = t[f] * Math.sqrt((CAT_CV[i] * CAT_CV[i]) / G + SCHEDULE_CV * SCHEDULE_CV);
  }
  return { mean, sd };
}

/** P(A beats B) per category (TO: lower wins). */
export function catWinProbs(a: Dist, b: Dist): number[] {
  const out = new Array<number>(9);
  for (let c = 0; c < 9; c++) {
    const d = Math.sqrt(a.sd[c] * a.sd[c] + b.sd[c] * b.sd[c]);
    const diff = a.mean[c] - b.mean[c];
    const z = d > 0 ? diff / d : diff > 0 ? 8 : diff < 0 ? -8 : 0;
    out[c] = phi(c === 8 ? -z : z);
  }
  return out;
}

/** P(win >= 5 of the 9 categories) for independent category win probabilities. */
export function matchWinProb(p: number[]): number {
  return winAtLeast(Float64Array.from(p), 0);
}

/**
 * How much a category should steer today's decisions: 1 for a toss-up (P in [0.25, 0.75]), falling to 0.2 for a secured or lost category.
 * 0.2 + 0.8 * min(1, p(1-p) / 0.1875).
 */
export function leverageOf(p: number): number {
  return 0.2 + 0.8 * Math.min(1, (p * (1 - p)) / 0.1875);
}
export const leverageWeights = (p: number[]): number[] => p.map(leverageOf);

export const catIndex = (name: string): number => SEASON_CATS.indexOf(name as (typeof SEASON_CATS)[number]);

/** Average of several per-category probability vectors. */
export function meanVec(vs: number[][]): number[] {
  const out = new Array<number>(9).fill(0);
  for (const v of vs) for (let i = 0; i < 9; i++) out[i] += v[i] / vs.length;
  return out;
}
