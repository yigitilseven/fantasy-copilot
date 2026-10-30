import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { leagueRoster, players } from "@/db/schema";
import { SeasonError, applyRosterMoves, getLeague, getRosters, getState, getTeams, insertTransaction, lastYahooSync, lastYahooSyncByTeam, loadFreeAgents, markTransactionApplied, recordAdds, setState, setTeamYahooId, syncTeamRoster, upsertFreeAgents, type FreeAgentRow, type RosterSyncEntry, type TxnAction } from "@/db/season";
import { league as leagueTable, leagueTransactions as leagueTransactionsTable } from "@/db/schema";
import { buildNameIndex, ensureFreeAgentFromStats, matchPlayer, yahooKeyFor } from "@/integrations/yahoo/dom-ingest";
import { nameKey } from "@/integrations/projections/names";
import { loadSchedule } from "@/integrations/schedule/nba-schedule";
import { defaultStatsCacheDir } from "@/integrations/projections/stats-lookup";
import type { MatchupData, MatchupSide } from "@/engine/season/evaluate";
import { fantasyWeekNumber, gameDayOf, weekStartOf } from "@/engine/season/schedule";
import type { TagMap } from "./season-players";

/** Ingestion of what the userscript reads on Yahoo league pages. Best-effort: calibrated later from real snapshots (see extension/README.md). */

const playerRow = z.object({
  yahooId: z.string().max(20).optional(),
  playerName: z.string().min(2).max(80),
  nbaTeam: z.string().max(5).optional(),
  positions: z.string().max(20).optional(),
  slot: z.string().max(8).optional(),
  injuryTag: z.string().max(8).optional(),
  pctOwned: z.number().min(0).max(100).optional(),
  opp: z.string().max(30).optional(),
  hasGame: z.boolean().optional(),
  stats: z.record(z.string(), z.number()).optional(),
});

export const rosterBody = z.object({
  url: z.string().max(500).optional(),
  teamName: z.string().max(80).optional(),
  teamId: z.string().max(12).optional(),
  /** true when the page is the user's own "My Team" view (no team name on the page). */
  mine: z.boolean().optional(),
  players: z.array(playerRow).min(1).max(40),
});
export const freeAgentsBody = z.object({
  url: z.string().max(500).optional(),
  players: z.array(playerRow).min(1).max(300),
});
const sideSchema = z.object({
  name: z.string().min(1).max(80),
  /** Yahoo team id from the link next to the name (more reliable than the name). */
  id: z.string().max(12).optional(),
  cats: z.record(z.string(), z.number()),
  gamesPlayed: z.number().nullable().optional(),
  gamesRemaining: z.number().nullable().optional(),
});
export const matchupBody = z.object({
  url: z.string().max(500).optional(),
  week: z.number().int().min(1).max(40).nullable().optional(),
  teams: z.array(sideSchema).length(2),
});

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const SLOT_NORM: Record<string, string> = { "IL+": "IL", "BENCH": "BN", "BE": "BN" };

function statusOfSlot(slot: string | null | undefined): "active" | "bench" | "il" {
  const s = (slot ?? "").toUpperCase();
  return s === "IL" || s === "IL+" ? "il" : s === "BN" || s === "NA" || s === "BE" ? "bench" : "active";
}

function matchRows(db: Db, rows: z.infer<typeof playerRow>[]) {
  const index = buildNameIndex(db);
  const taken = new Set<string>();
  const matched: { row: z.infer<typeof playerRow>; playerId: string }[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  for (const row of rows) {
    const m = matchPlayer(index, { playerName: row.playerName, nbaTeam: row.nbaTeam, positions: row.positions, yahooId: row.yahooId }, taken);
    if (m.ok) {
      taken.add(m.player.id);
      matched.push({ row, playerId: m.player.id });
    } else unmatched.push({ name: row.playerName, reason: m.reason });
  }
  // Remember Yahoo ids so the next match is exact.
  for (const { row, playerId } of matched) {
    if (!row.yahooId) continue;
    const p = db.select({ key: players.yahooPlayerKey }).from(players).where(eq(players.id, playerId)).get();
    if (p && !p.key) db.update(players).set({ yahooPlayerKey: yahooKeyFor(row.yahooId) }).where(eq(players.id, playerId)).run();
  }
  return { matched, unmatched };
}

function putTags(db: Db, leagueId: number, items: { playerId: string; tag: string | null }[], now: string) {
  const cur = getState<TagMap>(db, leagueId, "tags")?.value ?? {};
  const cutoff = Date.parse(now) - 7 * 86_400_000;
  for (const [k, v] of Object.entries(cur)) if (Date.parse(v.at) < cutoff) delete cur[k];
  for (const i of items) cur[i.playerId] = { tag: i.tag, at: now };
  setState(db, leagueId, "tags", cur, now);
}

function requireLeague(db: Db) {
  const lg = getLeague(db);
  if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet: run `pnpm season:init --draft=<id>` first");
  return lg;
}

export interface RosterIngestResult {
  team: { slot: number; name: string; isUser: boolean };
  matched: number;
  unmatched: { name: string; reason: string }[];
  added: string[];
  dropped: string[];
  moved: string[];
  addsRecorded: number;
  /** true = unmatched names meant no player was dropped (roster only extended / updated). */
  partial: boolean;
}

export function ingestRoster(db: Db, body: z.infer<typeof rosterBody>, now = new Date().toISOString()): RosterIngestResult {
  const lg = requireLeague(db);
  const teams = getTeams(db, lg.id);
  let team = body.teamId ? teams.find((t) => t.yahooTeamId === body.teamId) : undefined;
  if (!team && body.teamName) {
    const n = norm(body.teamName);
    team = teams.find((t) => norm(t.name) === n) ?? teams.find((t) => n.length >= 4 && (norm(t.name).startsWith(n) || n.startsWith(norm(t.name))));
  }
  if (!team && body.mine) team = teams.find((t) => t.isUser);
  const mr = matchRows(db, body.players);
  if (!team && body.teamId) {
    // Renamed team: the draft roster that overlaps most with this page (among teams not yet mapped to a Yahoo id) is the one.
    const have = getRosters(db, lg.id);
    const ids = new Set(mr.matched.map((m) => m.playerId));
    const scored = teams.filter((t) => !t.yahooTeamId).map((t) => ({ t, n: (have.get(t.slot) ?? []).filter((r) => ids.has(r.playerId)).length })).sort((a, b) => b.n - a.n);
    if (scored[0] && scored[0].n >= 3 && scored[0].n > (scored[1]?.n ?? 0)) team = scored[0].t;
  }
  if (!team) throw new SeasonError("TEAM_NOT_FOUND", `Team "${body.teamName ?? body.teamId ?? "?"}" is not one of this league's teams`);
  if (body.teamId && !team.yahooTeamId) setTeamYahooId(db, lg.id, team.slot, body.teamId);

  const { matched, unmatched } = mr;
  if (!matched.length) throw new SeasonError("PLAYER_NOT_FOUND", `None of the ${body.players.length} players on the page matched (${unmatched.slice(0, 3).map((u) => u.name).join(", ")})`);
  const entries: RosterSyncEntry[] = matched.map(({ row, playerId }) => {
    const slot = row.slot ? (SLOT_NORM[row.slot.toUpperCase()] ?? row.slot.toUpperCase()) : null;
    return { playerId, lineupSlot: slot, status: statusOfSlot(row.slot) };
  });
  const partial = unmatched.length > 0;
  let toSync = entries;
  if (partial) {
    // Unknown names: never drop anybody on incomplete information.
    const have = (getRosters(db, lg.id).get(team.slot) ?? []).filter((r) => !entries.some((e) => e.playerId === r.playerId)).map((r) => ({ playerId: r.playerId, lineupSlot: r.lineupSlot, status: r.status }));
    toSync = [...entries, ...have];
  }
  const baseline = lastYahooSync(db, lg.id, team.slot) !== null;
  const res = syncTeamRoster(db, lg.id, team.slot, toSync, "yahoo-page", now);
  putTags(db, lg.id, matched.map(({ row, playerId }) => ({ playerId, tag: row.injuryTag ?? null })), now);

  // Count adds for the weekly limit: only for the user's team, only after a first Yahoo sync established the baseline, only once the season runs.
  let addsRecorded = 0;
  if (team.isUser && baseline && res.added.length) {
    const sch = loadSchedule(defaultStatsCacheDir());
    const day = gameDayOf(Date.parse(now), lg.settings.timezone);
    if (!sch?.firstDate || day >= sch.firstDate) {
      recordAdds(db, lg.id, weekStartOf(day), res.added, "roster-sync", now);
      addsRecorded = res.added.length;
    }
  }
  return { team: { slot: team.slot, name: team.name, isUser: team.isUser }, matched: matched.length, unmatched, added: res.added, dropped: partial ? [] : res.dropped, moved: res.moved, addsRecorded, partial };
}

export interface FreeAgentIngestResult { received: number; matched: number; unmatched: { name: string; reason: string }[]; poolSize: number; freedFromRosters: string[]; /** players created from their NBA.com stats */ created: string[] }

export function ingestFreeAgents(db: Db, body: z.infer<typeof freeAgentsBody>, now = new Date().toISOString(), statsCacheDir = defaultStatsCacheDir()): FreeAgentIngestResult {
  const lg = requireLeague(db);
  const { matched, unmatched: missed } = matchRows(db, body.players);
  // Unknown to the projections (late signings, two-ways, name variants): create them from real NBA stats so they get scored.
  const created: string[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  for (const u of missed) {
    const row = body.players.find((p) => p.playerName === u.name)!;
    const id = u.reason === "unmatched" ? ensureFreeAgentFromStats(db, row, statsCacheDir) : null;
    if (id) {
      matched.push({ row, playerId: id });
      created.push(row.playerName);
    } else unmatched.push(u);
  }
  const byName = new Map(matched.map((m) => [m.row, m.playerId]));
  const rows: FreeAgentRow[] = body.players.map((p) => ({
    yahooId: p.yahooId ?? `n:${nameKey(p.playerName)}`,
    playerId: byName.get(p) ?? null,
    name: p.playerName, nbaTeam: p.nbaTeam ?? null, positions: p.positions ?? null, pctOwned: p.pctOwned ?? null, injuryTag: p.injuryTag ?? null, stats: p.stats ?? null, capturedAt: now,
  }));
  upsertFreeAgents(db, lg.id, rows);
  putTags(db, lg.id, matched.map(({ row, playerId }) => ({ playerId, tag: row.injuryTag ?? null })), now);
  // A player Yahoo lists as available but we still show on another team's (draft-time) roster was dropped since: free him.
  const freed: string[] = [];
  for (const [teamSlot, list] of getRosters(db, lg.id)) {
    if (teamSlot === lg.userSlot) continue;
    for (const r of list) {
      if (r.source === "draft" && matched.some((m) => m.playerId === r.playerId)) {
        db.delete(leagueRoster).where(and(eq(leagueRoster.leagueId, lg.id), eq(leagueRoster.playerId, r.playerId))).run();
        freed.push(r.playerId);
      }
    }
  }
  return { received: body.players.length, matched: matched.length, unmatched, poolSize: loadFreeAgents(db, lg.id).filter((r) => r.playerId).length, freedFromRosters: freed, created };
}

const CAT_KEYS: Record<string, keyof MatchupSide["cats"]> = {
  "fg%": "fgPct", fgpct: "fgPct", "ft%": "ftPct", ftpct: "ftPct", "3ptm": "threePm", "3pm": "threePm", threepm: "threePm", pts: "pts", reb: "reb", ast: "ast",
  st: "stl", stl: "stl", blk: "blk", to: "tov", tov: "tov", fgm: "fgm", fga: "fga", ftm: "ftm", fta: "fta",
};
function normalizeCats(raw: Record<string, number>): MatchupSide["cats"] {
  const out: MatchupSide["cats"] = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = CAT_KEYS[k.toLowerCase().replace(/\s+/g, "")] ?? (k as keyof MatchupSide["cats"]);
    if (Number.isFinite(v) && key in { fgPct: 1, ftPct: 1, fgm: 1, fga: 1, ftm: 1, fta: 1, threePm: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 1 }) out[key] = v > 1 && (key === "fgPct" || key === "ftPct") ? v / 100 : v;
  }
  return out;
}

export interface MatchupIngestResult { stored: boolean; ignored?: string; you?: string; opp?: string; week: number | null }

export function ingestMatchup(db: Db, body: z.infer<typeof matchupBody>, now = new Date().toISOString()): MatchupIngestResult {
  const lg = requireLeague(db);
  const teams = getTeams(db, lg.id);
  const user = teams.find((t) => t.isUser)!;
  const idx = body.teams.map((t) => (user.yahooTeamId && t.id ? t.id === user.yahooTeamId : norm(t.name) === norm(user.name)));
  const youIdx = idx[0] ? 0 : idx[1] ? 1 : -1;
  if (youIdx < 0) throw new SeasonError("TEAM_NOT_FOUND", `Your team "${user.name}" is not on this matchup page (${body.teams.map((t) => t.name).join(" vs ")})`);
  const day = gameDayOf(Date.parse(now), lg.settings.timezone);
  const sch = loadSchedule(defaultStatsCacheDir());
  const current = fantasyWeekNumber(sch, day);
  if (body.week != null && current != null && body.week !== current) return { stored: false, ignored: `page shows week ${body.week}, current week is ${current}`, week: body.week };
  const mk = (t: z.infer<typeof sideSchema>): MatchupSide => ({ name: t.name, cats: normalizeCats(t.cats), gamesPlayed: t.gamesPlayed ?? null, gamesRemaining: t.gamesRemaining ?? null });
  const data: MatchupData = { week: body.week ?? current, weekStart: weekStartOf(day), capturedAt: now, you: mk(body.teams[youIdx]), opp: mk(body.teams[1 - youIdx]) };
  setState(db, lg.id, "matchup", data, now);
  return { stored: true, you: data.you.name, opp: data.opp.name, week: data.week };
}


// ----------------------------------------------------------------------------------------------- discovery

export const discoverBody = z.object({
  leagueId: z.string().regex(/^\d{1,12}$/),
  myTeamId: z.string().max(12).optional(),
  teams: z.array(z.object({ id: z.string().max(12), name: z.string().max(80).optional() })).max(40),
});

export interface DiscoveryResult { leagueId: string; userTeamId: string | null; mapped: number; unmapped: string[]; teams: { slot: number; name: string; isUser: boolean; yahooTeamId: string | null }[] }

const sameName = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return !!x && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))));
};

/** Maps Yahoo team ids (from the league navigation) to this league's teams: my team id -> the user's team, names -> the rest. */
export function ingestDiscovery(db: Db, body: z.infer<typeof discoverBody>, now = new Date().toISOString()): DiscoveryResult {
  const lg = requireLeague(db);
  const teams = getTeams(db, lg.id);
  const assigned = new Map<string, number>(); // yahoo id -> slot
  const set = (id: string, slot: number) => {
    assigned.set(id, slot);
    const t = teams.find((x) => x.slot === slot)!;
    if (t.yahooTeamId !== id) {
      setTeamYahooId(db, lg.id, slot, id);
      t.yahooTeamId = id;
    }
  };
  const ids = new Set(body.teams.map((t) => t.id));
  if (body.myTeamId) ids.add(body.myTeamId);
  for (const t of teams) if (t.yahooTeamId && ids.has(t.yahooTeamId) && t.yahooTeamId !== body.myTeamId) assigned.set(t.yahooTeamId, t.slot);
  const user = teams.find((t) => t.isUser);
  if (body.myTeamId && user) {
    for (const [id, slot] of [...assigned]) if (slot === user.slot && id !== body.myTeamId) assigned.delete(id);
    set(body.myTeamId, user.slot);
  }
  const free = () => teams.filter((t) => ![...assigned.values()].includes(t.slot));
  for (const t of body.teams) {
    if (assigned.has(t.id) || !t.name) continue;
    const hit = free().filter((x) => sameName(x.name, t.name!));
    if (hit.length === 1) set(t.id, hit[0].slot);
  }
  // Renamed teams: a shared word in the name ("Orthobros") pairs them when it is unambiguous.
  const words = (x: string) => new Set(norm(x).split(" ").filter((w) => w.length >= 4));
  for (const t of body.teams) {
    if (assigned.has(t.id) || !t.name) continue;
    const wa = words(t.name);
    const hit = free().filter((x) => [...words(x.name)].some((w) => wa.has(w)));
    if (hit.length === 1) set(t.id, hit[0].slot);
  }
  const leftIds = [...ids].filter((id) => !assigned.has(id));
  const leftSlots = free();
  if (leftIds.length === 1 && leftSlots.length === 1) set(leftIds[0], leftSlots[0].slot);
  const l = db.select().from(leagueTable).where(eq(leagueTable.id, lg.id)).get();
  const key = l?.yahooLeagueKey ?? null;
  if (!key || !key.startsWith(body.leagueId)) db.update(leagueTable).set({ yahooLeagueKey: `nba.l.${body.leagueId}`, updatedAt: now }).where(eq(leagueTable.id, lg.id)).run();
  setState(db, lg.id, "discovery", { leagueId: body.leagueId, myTeamId: body.myTeamId ?? null, teams: body.teams }, now);
  const out = getTeams(db, lg.id);
  return {
    leagueId: body.leagueId, userTeamId: out.find((t) => t.isUser)?.yahooTeamId ?? null,
    mapped: out.filter((t) => t.yahooTeamId).length, unmapped: [...ids].filter((id) => !out.some((t) => t.yahooTeamId === id)),
    teams: out.map((t) => ({ slot: t.slot, name: t.name, isUser: t.isUser, yahooTeamId: t.yahooTeamId })),
  };
}

// ----------------------------------------------------------------------------------------------- transactions

export const transactionsBody = z.object({
  url: z.string().max(500).optional(),
  rows: z
    .array(
      z.object({
        key: z.string().min(3).max(300),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
        type: z.string().max(12),
        actions: z
          .array(z.object({ action: z.enum(["add", "drop", "trade"]), yahooId: z.string().max(20), name: z.string().min(2).max(80), nbaTeam: z.string().max(5).optional(), positions: z.string().max(20).optional(), teamId: z.string().max(12).optional(), teamName: z.string().max(80).optional() }))
          .min(1)
          .max(12),
      }),
    )
    .min(1)
    .max(500),
});

export interface TransactionIngestResult { received: number; inserted: number; applied: number; skippedStale: number; unmatched: string[]; addsRecorded: number }

/** Pacific-ish league time -> UTC ms (date-only rows count as midday). */
const txnMs = (date: string, time: string | null | undefined) => Date.parse(`${date}T${time ?? "12:00"}:00Z`) + 7 * 3_600_000;

/**
 * Stores Yahoo transactions (deduped by key) and applies the new ones to league_roster, oldest first, on top of whatever the rosters are:
 * a team whose roster page was read after the transaction already reflects it (skipped). Adds by the user's team count toward the weekly limit.
 */
export function ingestTransactions(db: Db, body: z.infer<typeof transactionsBody>, now = new Date().toISOString()): TransactionIngestResult {
  const lg = requireLeague(db);
  const teams = getTeams(db, lg.id);
  const synced = lastYahooSyncByTeam(db, lg.id);
  const index = buildNameIndex(db);
  const sch = loadSchedule(defaultStatsCacheDir());
  const slotOf = (a: { teamId?: string; teamName?: string }) => {
    if (a.teamId) {
      const t = teams.find((x) => x.yahooTeamId === a.teamId);
      if (t) return t.slot;
    }
    if (a.teamName) return teams.find((x) => sameName(x.name, a.teamName!))?.slot ?? null;
    return null;
  };
  // Page order is newest first: process oldest first (stable for equal timestamps).
  const rows = body.rows.map((r, i) => ({ r, i })).sort((a, b) => txnMs(a.r.date ?? "9999-12-31", a.r.time) - txnMs(b.r.date ?? "9999-12-31", b.r.time) || b.i - a.i).map((x) => x.r);
  const res: TransactionIngestResult = { received: body.rows.length, inserted: 0, applied: 0, skippedStale: 0, unmatched: [], addsRecorded: 0 };
  for (const row of rows) {
    const actions: TxnAction[] = row.actions.map((a) => {
      const m = matchPlayer(index, { playerName: a.name, nbaTeam: a.nbaTeam, positions: a.positions, yahooId: a.yahooId });
      if (!m.ok) res.unmatched.push(a.name);
      return { action: a.action, yahooId: a.yahooId, name: a.name, playerId: m.ok ? m.player.id : null, teamSlot: slotOf(a), teamName: a.teamName };
    });
    const id = insertTransaction(db, lg.id, { key: row.key, kind: row.type, occurredOn: row.date ?? null, occurredTime: row.time ?? null, actions }, now);
    if (id === null) continue;
    res.inserted++;
    const when = row.date ? txnMs(row.date, row.time) : null;
    const perTeam = new Map<number, { add: string[]; drop: string[] }>();
    for (const a of actions) {
      if (!a.playerId || a.teamSlot == null) continue;
      const stale = when != null && synced.has(a.teamSlot) && when <= Date.parse(synced.get(a.teamSlot)!);
      if (stale) {
        res.skippedStale++;
        continue;
      }
      const m = perTeam.get(a.teamSlot) ?? { add: [], drop: [] };
      (a.action === "drop" ? m.drop : m.add).push(a.playerId);
      perTeam.set(a.teamSlot, m);
    }
    for (const [slot, mv] of perTeam) {
      const r = applyRosterMoves(db, lg.id, slot, mv, now);
      res.applied += r.added.length + r.dropped.length;
    }
    markTransactionApplied(db, id);
    // Weekly add limit: the user's pure adds (not trade receipts) once the season runs.
    if (row.date && row.type !== "trade") {
      const mineAdds = actions.filter((a) => a.action === "add" && a.playerId && a.teamSlot === lg.userSlot).map((a) => a.playerId!);
      if (mineAdds.length && (!sch?.firstDate || row.date >= sch.firstDate)) {
        recordAdds(db, lg.id, weekStartOf(row.date), mineAdds, "transaction", now);
        res.addsRecorded += mineAdds.length;
      }
    }
  }
  return res;
}

// ----------------------------------------------------------------------------------------------- sync report + status

export const syncReportBody = z.object({}).passthrough();

export function recordSyncReport(db: Db, report: Record<string, unknown>, now = new Date().toISOString()): void {
  const lg = getLeague(db);
  if (!lg) return;
  setState(db, lg.id, "sync", { ...report, receivedAt: now }, now);
  if (report.complete === true) setState(db, lg.id, "syncFull", { at: now }, now);
}

interface PartInfo { ok: boolean; detail: string }
export interface SyncStatus {
  league: { id: number; name: string; teams: number } | null;
  lastAttemptAt: string | null;
  lastFullAt: string | null;
  stopped: string | null;
  requests: number;
  parts: { discovery: PartInfo; myTeam: PartInfo; teams: PartInfo; matchup: PartInfo; fas: PartInfo; transactions: PartInfo };
  roster: { count: number; syncedAt: string | null; source: "yahoo-page" | "draft" | "transaction" | "manual" | "none" };
  teamsSynced: number;
  teamsTotal: number;
  matchup: { opp: string | null; week: number | null; at: string | null };
  freeAgents: { count: number; at: string | null };
  transactions: { count: number; lastOn: string | null };
  parserNeedsUpdate: string[];
  now: string;
}

export function getSyncStatus(db: Db, now = Date.now()): SyncStatus {
  const lg = getLeague(db);
  const empty: PartInfo = { ok: false, detail: "not run" };
  const base: SyncStatus = {
    league: null, lastAttemptAt: null, lastFullAt: null, stopped: null, requests: 0,
    parts: { discovery: empty, myTeam: empty, teams: empty, matchup: empty, fas: empty, transactions: empty },
    roster: { count: 0, syncedAt: null, source: "none" }, teamsSynced: 0, teamsTotal: 0, matchup: { opp: null, week: null, at: null }, freeAgents: { count: 0, at: null },
    transactions: { count: 0, lastOn: null }, parserNeedsUpdate: [], now: new Date(now).toISOString(),
  };
  if (!lg) return base;
  const rep = getState<Record<string, any>>(db, lg.id, "sync"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = rep?.value?.parts ?? {};
  const part = (x: any, detail: string): PartInfo => (x ? { ok: !!x.ok, detail: x.ok ? detail : x.error ?? "failed" } : empty); // eslint-disable-line @typescript-eslint/no-explicit-any
  const rosters = getRosters(db, lg.id);
  const mineRows = rosters.get(lg.userSlot) ?? [];
  const synced = lastYahooSyncByTeam(db, lg.id);
  const fas = loadFreeAgents(db, lg.id);
  const m = getState<MatchupData>(db, lg.id, "matchup");
  const full = getState<{ at: string }>(db, lg.id, "syncFull");
  const txnCount = db.select().from(leagueTransactionsTable).where(eq(leagueTransactionsTable.leagueId, lg.id)).all();
  const mineSync = synced.get(lg.userSlot) ?? null;
  const need = new Set<string>(Array.isArray(rep?.value?.samples) ? (rep!.value.samples as string[]) : []);
  if (rep?.value) {
    if (p.myTeam && !p.myTeam.ok && /no player rows/.test(p.myTeam.error ?? "")) need.add("roster");
    if (p.matchup && !p.matchup.ok && /no category/.test(p.matchup.error ?? "")) need.add("matchup");
    if (p.fas && !p.fas.ok && /no player rows/.test(p.fas.error ?? "")) need.add("players");
  }
  return {
    ...base,
    league: { id: lg.id, name: lg.name, teams: lg.teams },
    lastAttemptAt: rep?.value?.finishedAt ?? null,
    lastFullAt: full?.value.at ?? null,
    stopped: rep?.value?.stopped ?? null,
    requests: rep?.value?.requests ?? 0,
    parts: {
      discovery: part(p.discovery, `${p.discovery?.mapped ?? "?"} teams mapped`),
      myTeam: part(p.myTeam, `roster ${p.myTeam?.count ?? "?"}`),
      teams: p.teams ? { ok: (p.teams.failed?.length ?? 0) === 0 && p.teams.ok > 0, detail: `${p.teams.ok}/${p.teams.total} teams` + (p.teams.failed?.length ? ` (${p.teams.failed.length} failed)` : "") } : empty,
      matchup: part(p.matchup, `vs ${p.matchup?.opp ?? "?"}`),
      fas: part(p.fas, p.fas?.skipped ? "list fresh, not re-read this run" : `${p.fas?.rows ?? "?"} FAs`),
      transactions: part(p.transactions, `${p.transactions?.rows ?? 0} moves`),
    },
    roster: { count: mineRows.length, syncedAt: mineSync, source: mineSync ? "yahoo-page" : mineRows[0]?.source ?? "none" },
    teamsSynced: synced.size,
    teamsTotal: lg.teams,
    matchup: { opp: m?.value.opp.name ?? null, week: m?.value.week ?? null, at: m?.updatedAt ?? null },
    freeAgents: { count: fas.length, at: fas.map((r) => r.capturedAt).sort().pop() ?? null },
    transactions: { count: txnCount.length, lastOn: txnCount.map((t) => t.occurredOn ?? "").sort().pop() || null },
    parserNeedsUpdate: [...need],
  };
}
