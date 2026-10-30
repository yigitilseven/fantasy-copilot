import { catWinProbs, distOf, matchWinProb, meanVec, type Dist } from "./matchup";
import { NS, S } from "./projection";
import { addDays, dateRange, gamesInRange, weekEndOf, weekStartOf } from "./schedule";
import { projectWindow } from "./window";
import { SEASON_CATS, type LineupContext, type SeasonPlayer, type StatVec } from "./types";

/** Category totals banked so far in the current matchup, as read from Yahoo's matchup page. */
export interface MatchupSide {
  name: string;
  cats: Partial<{ fgPct: number; ftPct: number; fgm: number; fga: number; ftm: number; fta: number; threePm: number; pts: number; reb: number; ast: number; stl: number; blk: number; tov: number }>;
  gamesPlayed?: number | null;
  gamesRemaining?: number | null;
}
export interface MatchupData {
  week: number | null;
  weekStart?: string | null;
  weekEnd?: string | null;
  capturedAt: string;
  you: MatchupSide;
  opp: MatchupSide;
}

/** How many full weeks after the current one the rest-of-season average looks at. */
export const ROS_WEEKS = 3;

export interface Opponent {
  slot: number;
  name: string;
  players: SeasonPlayer[];
}

export interface WeekDetail {
  winProb: number;
  /** P(win) per category in SEASON_CATS order. */
  catP: number[];
  you: Dist;
  opp: Dist;
  youCur: StatVec | null;
  oppCur: StatVec | null;
  youPlayerGames: number;
  oppPlayerGames: number;
}
export interface RosDetail {
  winProb: number;
  catP: number[];
  weeks: number;
}

export interface Model {
  weekDates: string[];
  rosWeeks: string[][];
  /** This week's win probability and detail for a roster. */
  week(roster: readonly SeasonPlayer[]): WeekDetail;
  /** Average weekly win probability over the next ROS_WEEKS full weeks vs all opponents. */
  ros(roster: readonly SeasonPlayer[]): RosDetail;
  opponentResolved: string | null;
}

/** Rebuilds an 11-vector of banked totals from page cats; missing attempts are estimated from the expected full-week volume. */
export function curVecOf(side: MatchupSide | undefined, elapsedFrac: number, fullWeek: StatVec): StatVec | null {
  if (!side) return null;
  const c = side.cats;
  const v = new Array<number>(NS).fill(0);
  const num = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  v[S.threePm] = num(c.threePm); v[S.pts] = num(c.pts); v[S.reb] = num(c.reb); v[S.ast] = num(c.ast); v[S.stl] = num(c.stl); v[S.blk] = num(c.blk); v[S.tov] = num(c.tov);
  const shoot = (made: number | undefined, att: number | undefined, pct: number | undefined, mi: number, ai: number) => {
    if (typeof made === "number" && typeof att === "number" && att > 0) {
      v[mi] = made;
      v[ai] = att;
    } else if (typeof pct === "number") {
      const a = Math.max(1, fullWeek[ai] * elapsedFrac);
      v[ai] = a;
      v[mi] = pct * a;
    }
  };
  shoot(c.fgm, c.fga, c.fgPct, S.fgm, S.fga);
  shoot(c.ftm, c.fta, c.ftPct, S.ftm, S.fta);
  return v;
}

/**
 * Builds the evaluators for one league state. Opponents' windows are projected once; each call to week()/ros() only projects the user's roster.
 * `matchup` (optional) supplies banked totals and identifies this week's opponent (by team name) so the remaining-week odds use his roster.
 */
export function buildModel(ctx: LineupContext, opponents: readonly Opponent[], matchup: MatchupData | null, schedule: { lastDate: string | null } | null): Model {
  const today = ctx.today;
  const wEnd = weekEndOf(today);
  const weekDates = dateRange(today, wEnd);
  const nextMon = addDays(weekStartOf(today), 7);
  const rosWeeks: string[][] = [];
  for (let i = 0; i < ROS_WEEKS; i++) {
    const start = addDays(nextMon, i * 7);
    if (schedule?.lastDate && start > schedule.lastDate) break;
    rosWeeks.push(dateRange(start, addDays(start, 6)));
  }
  if (!rosWeeks.length) rosWeeks.push(dateRange(nextMon, addDays(nextMon, 6)));

  const oppRem = opponents.map((o) => projectWindow(o.players, weekDates, ctx));
  const oppRos = rosWeeks.map((dates) => opponents.map((o) => distOf(null, projectWindow(o.players, dates, ctx))));

  const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const resolved = matchup ? opponents.findIndex((o) => normName(o.name) === normName(matchup.opp.name)) : -1;
  const elapsedFrac = Math.max(0, Math.min(1, (7 - weekDates.length) / 7));

  const week = (roster: readonly SeasonPlayer[]): WeekDetail => {
    const rem = projectWindow(roster, weekDates, ctx);
    const fullWeek = matchup ? projectWindow(roster, dateRange(weekStartOf(today), wEnd), ctx).totals : new Array<number>(NS).fill(0);
    const youCur = matchup ? curVecOf(matchup.you, elapsedFrac, fullWeek) : null;
    const oppCur = matchup ? curVecOf(matchup.opp, elapsedFrac, fullWeek) : null;
    const you = distOf(youCur, rem);
    const oppIdx = resolved >= 0 ? [resolved] : opponents.map((_, i) => i);
    const oppDists = oppIdx.map((j) => distOf(oppCur, oppRem[j]));
    const ps = oppDists.map((d) => catWinProbs(you, d));
    const catP = meanVec(ps);
    const winProb = ps.length ? ps.reduce((a, p) => a + matchWinProb(p), 0) / ps.length : 0.5;
    const oppAvg: Dist = { mean: SEASON_CATS.map((_, c) => oppDists.reduce((a, d) => a + d.mean[c], 0) / Math.max(1, oppDists.length)), sd: SEASON_CATS.map((_, c) => oppDists.reduce((a, d) => a + d.sd[c], 0) / Math.max(1, oppDists.length)) };
    return { winProb, catP, you, opp: oppAvg, youCur, oppCur, youPlayerGames: rem.playerGames, oppPlayerGames: oppIdx.reduce((a, j) => a + oppRem[j].playerGames, 0) / Math.max(1, oppIdx.length) };
  };

  const ros = (roster: readonly SeasonPlayer[]): RosDetail => {
    let win = 0;
    let n = 0;
    const cats: number[][] = [];
    rosWeeks.forEach((dates, w) => {
      const me = distOf(null, projectWindow(roster, dates, ctx));
      for (const od of oppRos[w]) {
        const p = catWinProbs(me, od);
        win += matchWinProb(p);
        cats.push(p);
        n++;
      }
    });
    return { winProb: n ? win / n : 0.5, catP: meanVec(cats.length ? cats : [new Array<number>(9).fill(0.5)]), weeks: rosWeeks.length };
  };

  return { weekDates, rosWeeks, week, ros, opponentResolved: resolved >= 0 ? opponents[resolved].name : null };
}

/** Games left this week for a team (schedule) or prorated 3.5/week without one. */
export function gamesLeftThisWeek(schedule: Record<string, string[]> | null, team: string, today: string): number {
  if (!schedule) return Math.round(((3.5 * (weekEndOf(today) > today ? dateRange(today, weekEndOf(today)).length : 1)) / 7) * 10) / 10;
  return gamesInRange(schedule, team, today, weekEndOf(today));
}
