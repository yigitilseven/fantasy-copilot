/**
 * NBA calendar approximation used to turn an estimated return date into "games missed".
 * 2026-27 regular season: Oct 20 2026 - Apr 11 2027, ~3.45 games per week, 82 games max.
 */
export const SEASON_START = "2026-10-20";
export const SEASON_END = "2027-04-11";
export const SEASON_GAMES = 82;
export const GAMES_PER_WEEK = 3.45;

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" (or a full ISO timestamp) -> UTC midnight ms; NaN when unparseable. */
export function dayMs(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/**
 * Regular-season games a player misses when he is out until `estReturn` (the first day he can play), evaluated at `now`.
 * Counts calendar days from max(now, season start) to min(estReturn, day after season end) at 3.45 games/week, capped at 82.
 * Returns 0 when the return date is not after the start of the counting window.
 */
export function gamesMissedUntil(estReturn: string, now: number | Date = Date.now()): number {
  const ret = dayMs(estReturn);
  if (Number.isNaN(ret)) return 0;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const nowDay = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const from = Math.max(nowDay, dayMs(SEASON_START));
  const to = Math.min(ret, dayMs(SEASON_END) + DAY_MS);
  if (to <= from) return 0;
  return Math.min(SEASON_GAMES, Math.round(((to - from) / DAY_MS) * (GAMES_PER_WEEK / 7)));
}

/** True when the estimated return is after the last regular-season day. */
export function returnsAfterSeason(estReturn: string): boolean {
  const ret = dayMs(estReturn);
  return !Number.isNaN(ret) && ret > dayMs(SEASON_END);
}
