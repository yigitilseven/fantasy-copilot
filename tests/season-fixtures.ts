import { addDays } from "@/engine/season/schedule";

export const TEAMS = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW", "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS"];

/** Deterministic pseudo-random generator. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A scheduleLeagueV2.json-shaped document: ~3.5 games per team and week between `from` and `to` (regular-season ids "002..."), plus one preseason game. */
export function makeScheduleJson(from = "2026-10-20", to = "2027-04-11", seed = 7, teams = TEAMS) {
  const r = rng(seed);
  const gameDates: { gameDate: string; games: Record<string, unknown>[] }[] = [];
  let n = 0;
  const preDate = addDays(from, -7);
  gameDates.push({ gameDate: us(preDate), games: [game("0012600001", preDate, teams[0], teams[1], "Preseason")] });
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const order = [...teams].sort(() => r() - 0.5);
    const k = Math.round((teams.length / 4) * (0.6 + 0.8 * r()));
    const games: Record<string, unknown>[] = [];
    for (let i = 0; i < k * 2 && i + 1 < order.length; i += 2) games.push(game(`002260${String(++n).padStart(4, "0")}`, d, order[i], order[i + 1], ""));
    gameDates.push({ gameDate: us(d), games });
  }
  return { meta: { version: 1 }, leagueSchedule: { seasonYear: "2026-27", gameDates } };
}

const us = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)} 00:00:00`;
function game(gameId: string, date: string, home: string, away: string, label: string) {
  return {
    gameId, gameLabel: label, gameDateEst: `${date}T00:00:00Z`, gameDateTimeEst: `${date}T19:30:00Z`,
    homeTeam: { teamId: 1, teamTricode: home }, awayTeam: { teamId: 2, teamTricode: away },
  };
}

// ------------------------------------------------------------------ engine helpers

import type { CategoryScores, Position } from "@/types";
import { DEFAULT_SEASON_SETTINGS, type InjuryInfo, type LineupContext, type SeasonPlayer, type SeasonSettings } from "@/engine/season/types";

export const AVG_LINE = [5, 11, 2.5, 3.2, 1.2, 15, 5, 3, 1, 0.6, 1.8];
const ZERO_Z = (): CategoryScores => ({ PTS: 0, "3PM": 0, REB: 0, AST: 0, STL: 0, BLK: 0, "FG%": 0, "FT%": 0, TO: 0 });

export function mkPlayer(id: string, o: { team?: string; pos?: Position[]; z?: Partial<CategoryScores>; line?: number[]; scale?: number; injury?: Partial<InjuryInfo>; avail?: number; minutes?: number } = {}): SeasonPlayer {
  const z = { ...ZERO_Z(), ...(o.z ?? {}) };
  const line = (o.line ?? AVG_LINE).map((x) => x * (o.scale ?? 1));
  return {
    id, name: id.toUpperCase(), team: o.team ?? "BOS", positions: o.pos ?? ["SF"], line, minutes: o.minutes ?? 30, avail: o.avail ?? 0.9,
    z, nineCat: Object.values(z).reduce((a, b) => a + b, 0), injury: { flag: "healthy", ...(o.injury ?? {}) },
  };
}

/** A context with a synthetic schedule where `teams` all play on the listed dates (or never). */
export function mkCtx(today: string, schedule: Record<string, string[]> | null, settings: Partial<SeasonSettings> = {}): LineupContext {
  return { settings: { ...DEFAULT_SEASON_SETTINGS, ...settings }, schedule, today };
}

/** Every team plays on every date in [from, to]. */
export function everyDay(teams: string[], from: string, to: string): Record<string, string[]> {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return Object.fromEntries(teams.map((t) => [t, dates]));
}

// ------------------------------------------------------------------ a small league for add/drop tests

import { parseScheduleJson } from "@/engine/season/schedule";
import type { RosterEntry } from "@/engine/season/types";
import type { Opponent } from "@/engine/season/evaluate";

const POS_CYCLE: Position[][] = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SF", "PF"], ["C", "PF"], ["SG", "SF"], ["PG"], ["PF"], ["C"], ["SF"]];

export interface LeagueFx {
  players: Map<string, SeasonPlayer>;
  entries: RosterEntry[];
  opponents: Opponent[];
  freeAgentIds: string[];
  ctx: LineupContext;
  schedule: ReturnType<typeof parseScheduleJson>;
}

/** 14 teams x 13 players of similar quality (slight random spread) + `faCount` free agents; the user is team 0. Needs a schedule (generated). */
export function makeLeague(opts: { today?: string; faCount?: number; seed?: number; userScale?: number } = {}): LeagueFx {
  const r = rng(opts.seed ?? 3);
  const schedule = parseScheduleJson(makeScheduleJson());
  const players = new Map<string, SeasonPlayer>();
  const mk = (id: string, i: number, scale: number) => {
    const spread = 0.8 + r() * 0.4;
    const p = mkPlayer(id, { team: TEAMS[(i * 7 + id.length) % TEAMS.length], pos: POS_CYCLE[i % POS_CYCLE.length], scale: scale * spread, z: { PTS: (spread - 1) * 6, REB: (r() - 0.5) * 3, AST: (r() - 0.5) * 3, STL: (r() - 0.5) * 2, "3PM": (r() - 0.5) * 3 } });
    players.set(id, p);
    return p;
  };
  const teams: SeasonPlayer[][] = [];
  for (let t = 0; t < 14; t++) teams.push(Array.from({ length: 13 }, (_, i) => mk(`t${t}p${i}`, i, t === 0 ? (opts.userScale ?? 1) : 1)));
  const fas = Array.from({ length: opts.faCount ?? 40 }, (_, i) => mk(`fa${i}`, i, 0.75).id);
  const today = opts.today ?? "2026-11-03";
  return {
    players, schedule, freeAgentIds: fas,
    entries: teams[0].map((p) => ({ playerId: p.id, slot: null, status: "active" as const })),
    opponents: teams.slice(1).map((ps, i) => ({ slot: i + 2, name: `Team ${i + 2}`, players: ps })),
    ctx: mkCtx(today, schedule.teams),
  };
}

// ------------------------------------------------------------------ DB league (14 teams x 13 drafted players + free agents)

import type { Db } from "@/db/client";
import { createDraft, recordPick } from "@/db/repository";
import { ensureDraftMeta, recordTeams } from "@/db/history";
import { seedFromRecords } from "@/db/seed";
import { createLeagueFromDraft } from "@/db/season";
import { makeRecord } from "./fixtures";

export const FIRST = ["Manager AC", "Blake", "Casey", "Drew", "Emery", "Finn", "Gray", "Hollis", "Idris", "Jules", "Kerry", "Lane", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sasha", "Tatum"];
export const LAST = ["Abbott", "Bishop", "Carver", "Dawson", "Ellis", "Farrow", "Gentry", "Hale", "Ingram", "Jarvis", "Keene", "Lowry", "Mercer", "Nash", "Ortega", "Pruitt", "Quade", "Rowe", "Stokes", "Thorne", "Upton", "Vance", "Wells", "Yardley", "Zeller"];
export const TEAM_NAMES = ["Alpha FC", "Bravo FC", "Charlie FC", "Delta FC", "Echo FC", "Foxtrot FC", "Golf FC", "Hotel FC", "India FC", "Juliet FC", "Kilo FC", "Lima FC", "Copilot Grizzlies", "November FC"];
export const playerName = (i: number) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= 500 ? i : ""}`;

/** Seeds 182 drafted players (snake draft by rank) + `fas` more, completes a 14-team draft with slot 13 as the user and bootstraps the league. */
export function seedSeasonLeague(db: Db, fas = 40): { draftId: number; leagueId: number; userIds: string[]; faIds: string[] } {
  const total = 182 + fas;
  const r = rng(11);
  const recs = Array.from({ length: total }, (_, i) =>
    makeRecord({
      id: `pl${i}`, name: playerName(i), positions: POS_CYCLE[i % POS_CYCLE.length], market: { rank: i + 1, yahooAdp: i + 1 },
      projection: { pts: 24 - i * 0.07 + r() * 3, reb: 4 + r() * 5, ast: 2 + r() * 4, stl: 0.6 + r() * 0.8, blk: 0.3 + r() * 0.8, threePm: 1 + r() * 2, minutes: 34 - i * 0.05 },
    }),
  );
  recs.forEach((rec, i) => (rec.player.nbaTeam = TEAMS[i % TEAMS.length]));
  seedFromRecords(db, recs);
  const draftId = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 }).id;
  for (let i = 0; i < 182; i++) recordPick(db, draftId, `pl${i}`, "yahoo-dom");
  recordTeams(db, draftId, TEAM_NAMES.map((name, i) => ({ slot: i + 1, name, isUser: i === 12 })));
  ensureDraftMeta(db, draftId, { yahooRoomKey: "100001/9", leagueName: "Test League", finishedAt: "2026-10-14T20:00:00Z" });
  const { league } = createLeagueFromDraft(db, draftId);
  return { draftId, leagueId: league.id, userIds: [], faIds: Array.from({ length: fas }, (_, i) => `pl${182 + i}`) };
}
