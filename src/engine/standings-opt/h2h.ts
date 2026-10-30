import { F, NF, VIEW_COUNT } from "./lines";
import { NCAT } from "./rank";
import { phi } from "./phi";

/**
 * Weekly head-to-head (Yahoo H2H 9-cat) model. A matchup is won with >= 5 of the 9 categories (a category tie counts 0.5 in Yahoo; the
 * continuous model below makes ties measure-zero, so it is ignored).
 *
 * WEEKLY MEAN of a team in a category = Σ players' per-game × expected games that week:
 *   expected games/week = WEEK_GAMES (3.5, 82 games over ~24 weeks) × availability, availability = projected GP / 82.
 * In the two "season total" views (proj, total) a player's packed line is per-game × GP, so weekly = total × 3.5/82 (availability is
 * built in); in the "avg" view (per-game values, i.e. a healthy player) weekly = per-game × 3.5. FG% / FT% = Σmakes/Σattempts of the weekly
 * lines.
 *
 * WEEKLY VARIANCE (independent games; documented approximation, not a fit):
 *   counting stat c:  sd = mean × sqrt(cv_c² / G + SCHEDULE_CV²)
 *     cv_c  = game-to-game coefficient of variation of one player's stat (PTS .38, REB .50, AST .55, 3PM .75, STL .80, BLK 1.0, TO .55)
 *     G     = player-games in a team-week (35: ~10 active players x 3.5), so team noise shrinks like 1/sqrt(G)
 *     SCHEDULE_CV = 5%: shared noise from 3-vs-4-game weeks and rest days.
 *   percentage:       sd = sqrt(p(1-p)/attempts_week) × PCT_INFLATION (1.25, game-to-game shooting is wider than binomial).
 * P(A wins category c vs B) = Φ((mean_A − mean_B) / sqrt(sd_A² + sd_B²)); TO is won by the LOWER value. P(matchup win) = Poisson-binomial
 * P(wins >= 5) over the nine categories (assumed independent). A category far out of reach has P ~ 0 and so adds ~nothing to the matchup
 * odds when improved a little: punting emerges from the objective instead of being forced.
 */
export const WEEK_GAMES = 3.5;
export const SEASON_GAMES = 82;
export const TEAM_WEEK_PLAYER_GAMES = 35;
export const SCHEDULE_CV = 0.05;
export const PCT_INFLATION = 1.25;
/** Per-game CV by roto category index (FG%, FT% unused). */
export const CAT_CV = [0, 0, 0.75, 0.38, 0.5, 0.55, 0.8, 1.0, 0.55];
/** Win probability >= this = a "core" category; < PUNT_P = punted/hopeless. */
export const CORE_P = 0.6;
export const PUNT_P = 0.3;
export const WIN_CATS = 5;

const COUNT_FIELDS = [F.threePm, F.pts, F.reb, F.ast, F.stl, F.blk, F.tov];

/** Weekly mean / sd (9 roto stats) of packed totals at `off` for `view` into mean[o..], sd[o..]. */
export function weekStatsInto(t: ArrayLike<number>, off: number, view: number, mean: Float64Array, sd: Float64Array, o: number): void {
  const s = view === VIEW_COUNT - 1 ? WEEK_GAMES : WEEK_GAMES / SEASON_GAMES;
  const fga = t[off + F.fga], fta = t[off + F.fta];
  const pf = fga > 0 ? t[off + F.fgm] / fga : 0;
  const pt = fta > 0 ? t[off + F.ftm] / fta : 0;
  mean[o] = pf;
  mean[o + 1] = pt;
  sd[o] = Math.sqrt((pf * (1 - pf)) / Math.max(1, fga * s)) * PCT_INFLATION;
  sd[o + 1] = Math.sqrt((pt * (1 - pt)) / Math.max(1, fta * s)) * PCT_INFLATION;
  for (let c = 2; c < NCAT; c++) {
    const m = t[off + COUNT_FIELDS[c - 2]] * s;
    mean[o + c] = m;
    sd[o + c] = m * Math.sqrt((CAT_CV[c] * CAT_CV[c]) / TEAM_WEEK_PLAYER_GAMES + SCHEDULE_CV * SCHEDULE_CV);
  }
}

/** P(A wins each category vs B) into out[oo..oo+9). */
export function catWinInto(mA: Float64Array, sA: Float64Array, oA: number, mB: Float64Array, sB: Float64Array, oB: number, out: Float64Array, oo: number): void {
  for (let c = 0; c < NCAT; c++) {
    const d = Math.sqrt(sA[oA + c] * sA[oA + c] + sB[oB + c] * sB[oB + c]);
    const diff = mA[oA + c] - mB[oB + c];
    const z = d > 0 ? diff / d : diff > 0 ? 8 : diff < 0 ? -8 : 0;
    out[oo + c] = phi(c === NCAT - 1 ? -z : z);
  }
}

const dp = new Float64Array(NCAT + 1);
/** Poisson-binomial P(at least `need` wins) over the nine category win probabilities p[o..o+9). */
export function winAtLeast(p: Float64Array, o: number, need = WIN_CATS): number {
  dp.fill(0);
  dp[0] = 1;
  for (let c = 0; c < NCAT; c++) {
    const q = p[o + c];
    for (let k = c + 1; k >= 1; k--) dp[k] = dp[k] * (1 - q) + dp[k - 1] * q;
    dp[0] *= 1 - q;
  }
  let s = 0;
  for (let k = need; k <= NCAT; k++) s += dp[k];
  return s;
}

export interface H2hRow {
  team: number;
  /** Average matchup win probability vs the other teams (round robin). */
  winProb: number;
  /** Average expected categories won per week. */
  catsWon: number;
  /** Opponents beaten with probability > 0.5. */
  beats: number;
  /** Average P(win) per category. */
  catP: number[];
  /** 1 = best by winProb. */
  rank: number;
}

/** Round-robin H2H table for one view of packed team totals (teams x VIEW_COUNT x NF). Pure helper for reports / summaries. */
export function h2hTable(totals: Float64Array, teams: number, view: number): H2hRow[] {
  const mean = new Float64Array(teams * NCAT);
  const sd = new Float64Array(teams * NCAT);
  for (let t = 0; t < teams; t++) weekStatsInto(totals, (t * VIEW_COUNT + view) * NF, view, mean, sd, t * NCAT);
  const p = new Float64Array(NCAT);
  const rows: H2hRow[] = [];
  for (let t = 0; t < teams; t++) {
    let win = 0, cats = 0, beats = 0;
    const catP = new Array<number>(NCAT).fill(0);
    for (let j = 0; j < teams; j++) {
      if (j === t) continue;
      catWinInto(mean, sd, t * NCAT, mean, sd, j * NCAT, p, 0);
      const w = winAtLeast(p, 0);
      win += w;
      if (w > 0.5) beats++;
      for (let c = 0; c < NCAT; c++) {
        cats += p[c];
        catP[c] += p[c] / (teams - 1);
      }
    }
    rows.push({ team: t, winProb: win / (teams - 1), catsWon: cats / (teams - 1), beats, catP, rank: 0 });
  }
  for (const r of rows) r.rank = 1 + rows.filter((o) => o.winProb > r.winProb + 1e-12).length;
  return rows;
}
