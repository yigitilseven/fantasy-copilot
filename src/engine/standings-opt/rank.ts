import { ROTO_CATEGORIES } from "../evaluation/standings";
import { F, NF, VIEW_COUNT, type OptView } from "./lines";

/**
 * Fast roto points for N teams from packed totals (typed arrays, no allocation per call). Same semantics as
 * evaluation/standings.ts `standingsFromStats`: values compared after rounding to the displayed precision, ties share the average
 * of the points they span, TO lower-is-better, overall rank = competition ranking by total.
 */
export const NCAT = ROTO_CATEGORIES.length; // 9

/** Display decimals per category for tie detection: FG%/FT% 3; counting stats 0 (totals) or 1 (the "avg" view). */
export function decimalsOf(view: OptView): number[] {
  const d = view === "avg" ? 1 : 0;
  return [3, 3, d, d, d, d, d, d, d];
}
export const VIEW_DECIMALS: number[][] = [decimalsOf("proj"), decimalsOf("total"), decimalsOf("avg")];

const roundTo = (x: number, d: number) => Math.round((x + Number.EPSILON) * 10 ** d) / 10 ** d;

/** The nine roto stats of a packed total (FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO) into out[o..o+9). */
export function statsInto(t: ArrayLike<number>, off: number, out: Float64Array, o: number): void {
  const fga = t[off + F.fga];
  const fta = t[off + F.fta];
  out[o] = fga > 0 ? t[off + F.fgm] / fga : 0;
  out[o + 1] = fta > 0 ? t[off + F.ftm] / fta : 0;
  out[o + 2] = t[off + F.threePm];
  out[o + 3] = t[off + F.pts];
  out[o + 4] = t[off + F.reb];
  out[o + 5] = t[off + F.ast];
  out[o + 6] = t[off + F.stl];
  out[o + 7] = t[off + F.blk];
  out[o + 8] = t[off + F.tov];
}

export interface RotoScratch {
  stats: Float64Array; // teams * NCAT (rounded, TO negated so that higher is always better)
  points: Float64Array; // teams * NCAT
  total: Float64Array; // teams
}
export function makeScratch(teams: number): RotoScratch {
  return { stats: new Float64Array(teams * NCAT), points: new Float64Array(teams * NCAT), total: new Float64Array(teams) };
}

/**
 * Roto points of every team for one view. `totals` is teams x VIEW_COUNT x NF packed; fills `s.points` / `s.total` and returns the
 * rank (competition) of `user`.
 */
export function rotoView(totals: Float64Array, teams: number, view: number, user: number, s: RotoScratch): number {
  const dec = VIEW_DECIMALS[view];
  for (let t = 0; t < teams; t++) {
    statsInto(totals, (t * VIEW_COUNT + view) * NF, s.stats, t * NCAT);
    for (let c = 0; c < NCAT; c++) {
      const v = roundTo(s.stats[t * NCAT + c], dec[c]);
      s.stats[t * NCAT + c] = c === NCAT - 1 ? -v || 0 : v; // TO: negate (lower is better); `|| 0` normalizes -0
    }
  }
  s.points.fill(1);
  for (let c = 0; c < NCAT; c++) {
    for (let i = 0; i < teams; i++) {
      const vi = s.stats[i * NCAT + c];
      for (let j = i + 1; j < teams; j++) {
        const vj = s.stats[j * NCAT + c];
        if (vi > vj) s.points[i * NCAT + c] += 1;
        else if (vi < vj) s.points[j * NCAT + c] += 1;
        else {
          s.points[i * NCAT + c] += 0.5;
          s.points[j * NCAT + c] += 0.5;
        }
      }
    }
  }
  for (let t = 0; t < teams; t++) {
    let sum = 0;
    for (let c = 0; c < NCAT; c++) sum += s.points[t * NCAT + c];
    s.total[t] = sum;
  }
  let rank = 1;
  for (let t = 0; t < teams; t++) if (t !== user && s.total[t] > s.total[user] + 1e-9) rank++;
  return rank;
}
