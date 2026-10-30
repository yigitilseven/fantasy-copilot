/** NBA schedule helpers: games per team per date, Yahoo fantasy weeks (Monday-Sunday). Pure. */

export type TeamDates = Record<string, string[]>;

export interface ScheduleData {
  season: string | null;
  /** team code -> sorted regular-season game dates (YYYY-MM-DD, US Eastern game date). */
  teams: TeamDates;
  firstDate: string | null;
  lastDate: string | null;
  games: number;
}

const ALIASES: Record<string, string> = { GS: "GSW", NO: "NOP", NOR: "NOP", NY: "NYK", SA: "SAS", PHO: "PHX", UTAH: "UTA", UTH: "UTA", WSH: "WAS", BRK: "BKN", CHO: "CHA" };
export const canonTeamCode = (t: string | null | undefined): string => {
  const u = (t ?? "").trim().toUpperCase();
  return ALIASES[u] ?? u;
};

/** Average games per team per fantasy week when the schedule is unknown (82 games over ~24 weeks). */
export const FALLBACK_GAMES_PER_WEEK = 3.5;

/**
 * Parses cdn.nba.com/static/json/staticData/scheduleLeagueV2.json:
 *   { leagueSchedule: { seasonYear, gameDates: [ { gameDate: "10/20/2026 00:00:00", games: [ { gameId, gameDateEst, gameLabel,
 *     homeTeam: { teamTricode }, awayTeam: { teamTricode } } ] } ] } }
 * Only regular-season games count (gameId "002...", else labels such as Preseason / All-Star / Play-In / Playoffs are skipped).
 * Throws when the document has no gameDates (e.g. an HTML block page).
 */
export function parseScheduleJson(json: unknown): ScheduleData {
  const ls = (json as { leagueSchedule?: { seasonYear?: string; gameDates?: unknown } } | null)?.leagueSchedule;
  const gameDates = ls?.gameDates;
  if (!Array.isArray(gameDates) || gameDates.length === 0) throw new Error("schedule: no leagueSchedule.gameDates");
  const teams: Record<string, Set<string>> = {};
  let games = 0;
  for (const gd of gameDates as { gameDate?: string; games?: unknown[] }[]) {
    for (const g of (gd.games ?? []) as Record<string, unknown>[]) {
      const id = String(g.gameId ?? "");
      const label = String(g.gameLabel ?? "");
      if (id ? !id.startsWith("002") : /preseason|all-star|play-?in|playoff|finals/i.test(label)) continue;
      const date = dateOf(g.gameDateEst as string | undefined) ?? dateOf(gd.gameDate);
      const home = canonTeamCode((g.homeTeam as { teamTricode?: string } | undefined)?.teamTricode);
      const away = canonTeamCode((g.awayTeam as { teamTricode?: string } | undefined)?.teamTricode);
      if (!date || !home || !away) continue;
      for (const t of [home, away]) (teams[t] ??= new Set()).add(date);
      games++;
    }
  }
  const out: TeamDates = {};
  let first: string | null = null;
  let last: string | null = null;
  for (const [t, set] of Object.entries(teams)) {
    out[t] = [...set].sort();
    if (!first || out[t][0] < first) first = out[t][0];
    if (!last || out[t][out[t].length - 1] > last) last = out[t][out[t].length - 1];
  }
  return { season: ls?.seasonYear ?? null, teams: out, firstDate: first, lastDate: last, games };
}

/** "2026-10-20T00:00:00Z" | "10/20/2026 00:00:00" | "2026-10-20" -> "2026-10-20"; null when unparseable. */
function dateOf(s: string | undefined | null): string | null {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : null;
}

// ---------------------------------------------------------------------------------------------------- date arithmetic (UTC, no DST)

const DAY = 86_400_000;
const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => fmt(ms(d) + n * DAY);
export const daysBetween = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY);
/** Monday of the Mon-Sun week containing `d`. */
export const weekStartOf = (d: string): string => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
export const weekEndOf = (d: string): string => addDays(weekStartOf(d), 6);
/** Dates from..to inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The game day for `now` in an IANA time zone (default: Pacific, when Yahoo rolls the lineup day over). */
export function gameDayOf(now: Date | number, timeZone = "America/Los_Angeles"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA = YYYY-MM-DD
}

/** Fantasy week number (1-based): week 1 is the Mon-Sun week of the first regular-season game. Null without a schedule. */
export function fantasyWeekNumber(sch: ScheduleData | null, date: string): number | null {
  if (!sch?.firstDate) return null;
  const n = Math.floor(daysBetween(weekStartOf(sch.firstDate), date) / 7) + 1;
  return n >= 1 ? n : null;
}

export function hasGame(sch: TeamDates | null, team: string, date: string): boolean {
  return !!sch?.[canonTeamCode(team)]?.includes(date);
}

export function gamesInRange(sch: TeamDates | null, team: string, from: string, to: string): number {
  if (!sch) return 0;
  const list = sch[canonTeamCode(team)];
  return list ? list.filter((d) => d >= from && d <= to).length : 0;
}

/** Total fantasy weeks left (including the current one) in the schedule; null without a schedule. */
export function weeksRemaining(sch: ScheduleData | null, date: string): number | null {
  if (!sch?.lastDate) return null;
  return Math.max(0, Math.floor(daysBetween(weekStartOf(date), weekStartOf(sch.lastDate)) / 7) + 1);
}
