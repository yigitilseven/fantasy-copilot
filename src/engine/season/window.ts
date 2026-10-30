import { assignSlots } from "./slots";
import { addScaled, lineOn, playProb, S, zeroVec } from "./projection";
import { hasGame } from "./schedule";
import { SEASON_CATS, type LineupContext, type SeasonPlayer } from "./types";
import type { WindowTotals } from "./matchup";

/** Games per team per day when the schedule is unknown (3.5 per 7 days). */
const FALLBACK_DAILY = 0.5;

/** Leverage-weighted per-game value of a player (z-scores in SEASON_CATS order, uniform weights = plain 9-cat value). */
export function weightedValue(p: SeasonPlayer, w?: number[]): number {
  let v = 0;
  for (let c = 0; c < 9; c++) v += (w ? w[c] : 1) * (p.z[SEASON_CATS[c]] ?? 0);
  return v;
}

/** Penalty (in z points) per unit of play probability lost, so a doubtful player ranks below a sure one of the same z. */
const DOUBT_PENALTY = 3;

export const startValue = (p: SeasonPlayer, prob: number, w?: number[]): number => weightedValue(p, w) - (1 - Math.min(1, prob / Math.max(p.avail, 1e-9))) * DOUBT_PENALTY;

/**
 * Expected totals of a roster over the given dates, playing the best legal daily lineup (see slots.ts). With a schedule only players whose
 * team plays count (and at most one lineup of slots per day); without a schedule every player gets 0.5 games/day and slots are not enforced.
 * `weights` are category leverage weights (default uniform).
 */
export function projectWindow(roster: readonly SeasonPlayer[], dates: readonly string[], ctx: LineupContext, weights?: number[]): WindowTotals {
  const totals = zeroVec();
  let playerGames = 0;
  const slots = ctx.settings.rosterSlots;
  for (const date of dates) {
    if (!ctx.schedule) {
      for (const p of roster) {
        const pr = playProb(p, date, ctx.today);
        if (pr > 0) {
          addScaled(totals, lineOn(p, date, ctx.today), pr * FALLBACK_DAILY);
          playerGames += pr * FALLBACK_DAILY;
        }
      }
      continue;
    }
    const cands: { p: SeasonPlayer; prob: number }[] = [];
    for (const p of roster) {
      if (!hasGame(ctx.schedule, p.team, date)) continue;
      const prob = playProb(p, date, ctx.today);
      if (prob > 0) cands.push({ p, prob });
    }
    if (!cands.length) continue;
    const byId = new Map(cands.map((c) => [c.p.id, c]));
    const placed = assignSlots(cands.map((c) => ({ id: c.p.id, positions: c.p.positions, value: startValue(c.p, c.prob, weights) })), slots);
    for (const id of placed) {
      if (!id) continue;
      const c = byId.get(id)!;
      addScaled(totals, lineOn(c.p, date, ctx.today), c.prob);
      playerGames += c.prob;
    }
  }
  return { totals, playerGames };
}

export { S };
