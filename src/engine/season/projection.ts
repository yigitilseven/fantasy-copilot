import { addDays } from "./schedule";
import type { SeasonPlayer, StatVec } from "./types";

export const NS = 11;
/** Indices into a StatVec (same as standings-opt F). */
export const S = { fgm: 0, fga: 1, ftm: 2, fta: 3, threePm: 4, pts: 5, reb: 6, ast: 7, stl: 8, blk: 9, tov: 10 } as const;

export const zeroVec = (): StatVec => new Array<number>(NS).fill(0);
export function addScaled(into: StatVec, v: StatVec, k: number): void {
  for (let i = 0; i < NS; i++) into[i] += v[i] * k;
}

/** Days an injured player with an unknown return date is assumed to stay out. */
export const UNKNOWN_RETURN_DAYS = 14;
/** Chance a game-time decision actually plays on the day of the decision. */
export const GTD_PLAY_PROB = 0.7;

/**
 * Probability that `p` plays (when his team has a game) on `date`, as seen on `today`.
 *  out-for-season 0; out: 0 until his estimated return (unknown: UNKNOWN_RETURN_DAYS days from today), then his availability;
 *  game-time decision: GTD_PLAY_PROB today, availability afterwards; healthy: availability.
 */
export function playProb(p: SeasonPlayer, date: string, today: string): number {
  const inj = p.injury;
  if (inj.flag === "ofs") return 0;
  if (inj.flag === "out") {
    const back = inj.estReturn ?? addDays(today, UNKNOWN_RETURN_DAYS);
    return date >= back ? p.avail : 0;
  }
  if (inj.flag === "gtd" && date <= today) return GTD_PLAY_PROB;
  return p.avail;
}

/** The per-game line of `p` on `date` (with a temporary teammate-out boost, if any). */
export function lineOn(p: SeasonPlayer, date: string, today: string): StatVec {
  const b = p.boost;
  if (!b) return p.line;
  const until = b.until ?? addDays(today, UNKNOWN_RETURN_DAYS);
  if (date >= until) return p.line;
  return p.line.map((x) => x * b.factor);
}
