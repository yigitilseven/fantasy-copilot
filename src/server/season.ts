import type { Db } from "@/db/client";
import { addsUsed, getAdds, getLeague, getRosters, getState, getTeams, lastYahooSync, loadFreeAgents, type LeagueInfo, type RosterRow } from "@/db/season";
import { getNewsStatus } from "@/integrations/news/update";
import { loadSchedule, scheduleStatus, type ScheduleStatus } from "@/integrations/schedule/nba-schedule";
import { defaultStatsCacheDir } from "@/integrations/projections/stats-lookup";
import { rankMoves, type MoveSuggestion } from "@/engine/season/addDrop";
import { buildModel, gamesLeftThisWeek, type MatchupData, type Opponent } from "@/engine/season/evaluate";
import { planDay, type DayLineup } from "@/engine/season/lineup";
import { leverageOf, leverageWeights } from "@/engine/season/matchup";
import { buildAlerts, computeBoosts, type SeasonAlert } from "@/engine/season/newsRules";
import { dateRange, daysBetween, fantasyWeekNumber, gameDayOf, hasGame, weekEndOf, weekStartOf } from "@/engine/season/schedule";
import { SEASON_CATS, type LineupContext, type RosterEntry, type SeasonPlayer, type SeasonSettings } from "@/engine/season/types";
import type { PlayerNewsItem } from "@/types";
import { loadSeasonPlayers } from "./season-players";

export const FA_MAX_AGE_MS = 3 * 86_400_000;
export const MIN_CAPTURED_FAS = 20;

export interface Freshness {
  roster: { at: string | null; ageMs: number | null; source: "yahoo-page" | "draft" | "none" };
  freeAgents: { at: string | null; ageMs: number | null; count: number; usable: boolean; source: "captured" | "all-unrostered"; unscored: string[] };
  news: { at: string | null; ageMs: number | null; stale: boolean };
  schedule: ScheduleStatus & { assumed: boolean };
  matchup: { at: string | null; ageMs: number | null; currentWeek: boolean };
}

export interface CatRow {
  cat: string;
  youCur: number | null;
  oppCur: number | null;
  youProj: number;
  oppProj: number;
  p: number;
  leverage: number;
  state: "toss-up" | "leaning" | "secured" | "lost";
}
export interface WeekBlock {
  number: number | null;
  start: string;
  end: string;
  daysLeft: number;
  opponent: string | null;
  matchupCaptured: boolean;
  winProb: number;
  cats: CatRow[];
  youGames: number;
  oppGames: number;
  addsUsed: number;
  addsLimit: number;
  addsRemaining: number;
}
export interface NewsRow {
  playerId: string;
  name: string;
  team: string;
  status: string;
  slot: string | null;
  injury?: string;
  estReturn?: string;
  tag?: string;
  headlines: PlayerNewsItem[];
}
export interface SeasonOverview {
  league: { id: number; name: string; teams: number; userSlot: number; userTeam: string; settings: SeasonSettings; sourceDraftId: number | null };
  date: string;
  /** The actual game day today (differs from `date` in the pre-season preview). */
  realDate: string;
  /** true = pre-season: `date` is opening night. */
  preview: boolean;
  generatedAt: string;
  seasonStarted: boolean | null;
  freshness: Freshness;
  lineup: DayLineup;
  week: WeekBlock;
  moves: { items: MoveSuggestion[]; baselineRosWin: number; evaluated: number; notes: string[]; faSource: "captured" | "all-unrostered"; faCount: number };
  alerts: SeasonAlert[];
  news: NewsRow[];
  roster: { playerId: string; name: string; team: string; positions: string; slot: string | null; status: string; flag: string; hasGameToday: boolean | null; gamesThisWeek: number }[];
}

const catState = (p: number): CatRow["state"] => (p >= 0.9 ? "secured" : p <= 0.1 ? "lost" : p >= 0.6 || p <= 0.4 ? "leaning" : "toss-up");
const ageOf = (iso: string | null, now: number) => (iso ? Math.max(0, now - Date.parse(iso)) : null);

/** Everything a computation needs, loaded once. */
export interface SeasonState {
  league: LeagueInfo;
  now: number;
  today: string;
  cacheDir: string;
  /** true = the season has not started and `today` is the first game day. */
  preview: boolean;
  realToday: string;
  ctx: LineupContext;
  scheduleData: ReturnType<typeof loadSchedule>;
  players: Map<string, SeasonPlayer>;
  news: Map<string, PlayerNewsItem[]>;
  userEntries: RosterEntry[];
  rosters: Map<number, RosterRow[]>;
  teams: ReturnType<typeof getTeams>;
  opponents: Opponent[];
  matchup: MatchupData | null;
  matchupAt: string | null;
  matchupCurrent: boolean;
  faIds: string[];
  faPct: Map<string, number>;
  faSource: "captured" | "all-unrostered";
  faCaptured: number;
  /** Fresh Yahoo free agents the engine cannot score (no projection and no NBA stats): names, so nobody is skipped silently. */
  faUnscored: string[];
  faAt: string | null;
}

export interface StateOptions { leagueId?: number; now?: number; date?: string; cacheDir?: string }

export function loadSeasonState(db: Db, opts: StateOptions = {}): SeasonState | null {
  const league = getLeague(db, opts.leagueId);
  if (!league) return null;
  const now = opts.now ?? Date.now();
  const settings = league.settings;
  const realToday = gameDayOf(now, settings.timezone);
  const cacheDir = opts.cacheDir ?? defaultStatsCacheDir();
  const scheduleData = loadSchedule(cacheDir);
  // Before opening night (and without an explicit date) everything is computed for the first game day, so the page and the brief are useful.
  const preview = !opts.date && !!scheduleData?.firstDate && realToday < scheduleData.firstDate;
  const today = opts.date ?? (preview ? scheduleData!.firstDate! : realToday);
  const ctx: LineupContext = { settings, schedule: scheduleData?.teams ?? null, today };
  const { players: base, news } = loadSeasonPlayers(db, league.id, now);
  const boosts = computeBoosts([...base.values()], today);
  const players = new Map<string, SeasonPlayer>();
  for (const [id, p] of base) {
    const b = boosts.get(id);
    players.set(id, b ? { ...p, boost: b } : p);
  }
  const rosters = getRosters(db, league.id);
  const teams = getTeams(db, league.id);
  const toEntry = (r: RosterRow): RosterEntry => ({ playerId: r.playerId, slot: r.lineupSlot, status: r.status });
  const userEntries = (rosters.get(league.userSlot) ?? []).map(toEntry);
  const opponents: Opponent[] = teams
    .filter((t) => t.slot !== league.userSlot)
    .map((t) => ({ slot: t.slot, name: t.name, players: (rosters.get(t.slot) ?? []).filter((r) => r.status !== "il").map((r) => players.get(r.playerId)).filter((p): p is SeasonPlayer => !!p) }));

  const m = getState<MatchupData>(db, league.id, "matchup");
  const matchupCurrent = !!m && weekStartOf(gameDayOf(Date.parse(m.value.capturedAt), settings.timezone)) === weekStartOf(today);
  const matchup = m && matchupCurrent ? m.value : null;

  const rostered = new Set<string>();
  for (const list of rosters.values()) for (const r of list) rostered.add(r.playerId);
  const captured = loadFreeAgents(db, league.id).filter((r) => r.playerId && now - Date.parse(r.capturedAt) < FA_MAX_AGE_MS && !rostered.has(r.playerId));
  const faPct = new Map<string, number>(captured.filter((r) => r.pctOwned != null).map((r) => [r.playerId!, r.pctOwned!]));
  const useCaptured = captured.length >= MIN_CAPTURED_FAS;
  let faIds: string[];
  if (useCaptured) faIds = captured.map((r) => r.playerId!);
  else faIds = [...players.values()].filter((p) => !rostered.has(p.id)).sort((a, b) => b.nineCat * b.avail - a.nineCat * a.avail).slice(0, 300).map((p) => p.id);
  const faAt = captured.map((r) => r.capturedAt).sort().pop() ?? null;
  const faUnscored = loadFreeAgents(db, league.id)
    .filter((r) => now - Date.parse(r.capturedAt) < FA_MAX_AGE_MS && (!r.playerId || !players.has(r.playerId)) && !(r.playerId && rostered.has(r.playerId)))
    .map((r) => r.name);
  return { league, now, today, cacheDir, preview, realToday, ctx, scheduleData, players, news, userEntries, rosters, teams, opponents, matchup, matchupAt: m?.updatedAt ?? null, matchupCurrent, faIds, faPct, faSource: useCaptured ? "captured" : "all-unrostered", faCaptured: captured.length, faUnscored, faAt };
}

export function computeFreshness(db: Db, s: SeasonState): Freshness {
  const { now, league, cacheDir } = s;
  const rosterAt = lastYahooSync(db, league.id, league.userSlot);
  const news = getNewsStatus(db);
  const sch = scheduleStatus(cacheDir, now);
  return {
    roster: { at: rosterAt ?? league.createdAt, ageMs: ageOf(rosterAt ?? league.createdAt, now), source: rosterAt ? "yahoo-page" : "draft" },
    freeAgents: { at: s.faAt, ageMs: ageOf(s.faAt, now), count: s.faCaptured, usable: s.faSource === "captured", source: s.faSource, unscored: s.faUnscored },
    news: { at: news.lastSuccessAt, ageMs: ageOf(news.lastSuccessAt, now), stale: !news.lastSuccessAt || now - Date.parse(news.lastSuccessAt) > 6 * 3_600_000 },
    schedule: { ...sch, assumed: sch.games === 0 },
    matchup: { at: s.matchupAt, ageMs: ageOf(s.matchupAt, now), currentWeek: s.matchupCurrent },
  };
}

/** Full season overview: today's lineup, this week's matchup, the best add/drop moves, alerts and news. Null without a league. */
export function computeSeason(db: Db, opts: StateOptions & { moveLimit?: number } = {}): SeasonOverview | null {
  const s = loadSeasonState(db, opts);
  if (!s) return null;
  const { league, ctx, today, players } = s;
  const settings = league.settings;
  const sched = s.scheduleData;
  const weekStart = weekStartOf(today);
  const weekEnd = weekEndOf(today);
  const adds = getAdds(db, league.id, weekStart);
  const used = addsUsed(adds);
  const remaining = Math.max(0, settings.weeklyAddLimit - used);

  const res = rankMoves({
    ctx, players, entries: s.userEntries, opponents: s.opponents, freeAgentIds: s.faIds, pctOwned: s.faPct, matchup: s.matchup,
    schedule: sched ? { lastDate: sched.lastDate } : null, addsRemaining: remaining, limit: opts.moveLimit ?? 8,
  });

  const lev = leverageWeights(res.baseline.week.catP);
  const lineup = planDay(s.userEntries, players, ctx, lev);

  const w = res.baseline.week;
  const cats: CatRow[] = SEASON_CATS.map((cat, i) => ({
    cat,
    youCur: w.youCur ? curValue(w.youCur, i) : null,
    oppCur: w.oppCur ? curValue(w.oppCur, i) : null,
    youProj: w.you.mean[i],
    oppProj: w.opp.mean[i],
    p: w.catP[i],
    leverage: leverageOf(w.catP[i]),
    state: catState(w.catP[i]),
  }));
  const model = buildModel(ctx, s.opponents, s.matchup, sched ? { lastDate: sched.lastDate } : null);
  const week: WeekBlock = {
    number: fantasyWeekNumber(sched, today), start: weekStart, end: weekEnd, daysLeft: dateRange(today, weekEnd).length,
    opponent: model.opponentResolved ?? s.matchup?.opp.name ?? null, matchupCaptured: !!s.matchup, winProb: w.winProb, cats,
    youGames: round1(w.youPlayerGames), oppGames: round1(w.oppPlayerGames), addsUsed: used, addsLimit: settings.weeklyAddLimit, addsRemaining: remaining,
  };

  const alerts = buildAlerts({ today, entries: s.userEntries, players, freeAgentIds: s.faIds, moves: res.moves, ilSlots: settings.ilSlots, droppable: res.droppable });

  const roster = s.userEntries.map((e) => ({ e, p: players.get(e.playerId) })).filter((x): x is { e: RosterEntry; p: SeasonPlayer } => !!x.p).map(({ e, p }) => ({
    playerId: p.id, name: p.name, team: p.team, positions: p.positions.join("/"), slot: e.slot, status: e.status, flag: p.injury.flag,
    hasGameToday: ctx.schedule ? hasGame(ctx.schedule, p.team, today) : null, gamesThisWeek: gamesLeftThisWeek(ctx.schedule, p.team, today),
  }));
  const newsRows: NewsRow[] = roster.map((r) => {
    const p = players.get(r.playerId)!;
    return { playerId: p.id, name: p.name, team: p.team, status: p.injury.flag, slot: r.slot, injury: p.injury.injury, estReturn: p.injury.estReturn, tag: p.injury.tag, headlines: s.news.get(p.id) ?? [] };
  }).sort((a, b) => (b.status !== "healthy" ? 1 : 0) - (a.status !== "healthy" ? 1 : 0) || b.headlines.length - a.headlines.length);

  return {
    league: { id: league.id, name: league.name, teams: league.teams, userSlot: league.userSlot, userTeam: s.teams.find((t) => t.isUser)?.name ?? "You", settings, sourceDraftId: league.sourceDraftId },
    date: today,
    realDate: s.realToday,
    preview: s.preview,
    generatedAt: new Date(s.now).toISOString(),
    seasonStarted: sched?.firstDate ? s.realToday >= sched.firstDate : null,
    freshness: computeFreshness(db, s),
    lineup, week,
    moves: { items: res.moves, baselineRosWin: res.baseline.ros.winProb, evaluated: res.evaluated, notes: res.notes, faSource: s.faSource, faCount: s.faIds.length },
    alerts, news: newsRows, roster,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Display value of category i from a banked-totals vector. */
function curValue(v: number[], i: number): number {
  switch (i) {
    case 0: return v[1] > 0 ? v[0] / v[1] : 0;
    case 1: return v[3] > 0 ? v[2] / v[3] : 0;
    case 2: return v[4];
    case 3: return v[5];
    case 4: return v[6];
    case 5: return v[7];
    case 6: return v[8];
    case 7: return v[9];
    default: return v[10];
  }
}

export { daysBetween };
