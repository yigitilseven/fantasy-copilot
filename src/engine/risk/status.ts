import type { InjuryStatus, PlayerNewsItem, Risk } from "@/types";
import { dayMs, gamesMissedUntil, SEASON_GAMES } from "./calendar";

export interface StatusUpdate {
  status: InjuryStatus;
  injury: string | null;
  estReturnDate: string | null;
  source: string;
  reportedAt: string;
}

/**
 * Overlays the latest ingested status onto a CSV-derived Risk (pure; the CSV row is never modified, so a reseed cannot
 * clobber news). An "out" player whose return date has already passed is day-to-day. For "out" the projected games are
 * reduced by the regular-season games missed until the estimated return; out-for-season -> 0 games.
 */
export function applyStatusUpdate(risk: Risk, u: StatusUpdate, news: PlayerNewsItem[], now: number = Date.now()): Risk {
  let status = u.status;
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  if (status === "out" && u.estReturnDate && dayMs(u.estReturnDate) <= today) status = "day-to-day";
  const next: Risk = { ...risk, currentStatus: status, statusSource: u.source, statusUpdatedAt: u.reportedAt };
  if (status !== "healthy") {
    if (u.injury) next.injuryNote = u.injury;
    if (u.estReturnDate) next.estReturn = u.estReturnDate;
  }
  if (status === "out-for-season") {
    next.gamesMissed = SEASON_GAMES;
    next.projectedGames = 0;
  } else if (status === "out" && u.estReturnDate) {
    const missed = gamesMissedUntil(u.estReturnDate, now);
    next.gamesMissed = missed;
    next.projectedGames = Math.max(0, risk.projectedGames - missed);
  }
  if (news.length) next.latestNews = news.slice(0, 3);
  return next;
}
