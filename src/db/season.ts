import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import { draftMeta, draftPicks, draftTeam, drafts, league, leagueFreeAgents, leagueRoster, leagueState, leagueTeam, leagueTransactions, rosterSnapshots, seasonBriefs } from "./schema";
import { DEFAULT_SEASON_SETTINGS, type SeasonSettings } from "@/engine/season/types";

/** Season mode persistence: league, teams, rosters, snapshots, captured free agents, small state, daily briefs. */

export class SeasonError extends Error {
  constructor(public code: "LEAGUE_NOT_FOUND" | "DRAFT_NOT_FOUND" | "TEAM_NOT_FOUND" | "PLAYER_NOT_FOUND" | "INVALID", message: string) {
    super(message);
    this.name = "SeasonError";
  }
}

const SLOT_RE = /^(PG|SG|G|SF|PF|F|C|UTIL)$/;

/** Merges a partial settings object over the defaults and clamps it to sane values. Unknown keys are dropped. */
export function sanitizeSettings(partial: unknown, base: SeasonSettings = DEFAULT_SEASON_SETTINGS): SeasonSettings {
  const p = (partial && typeof partial === "object" ? partial : {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const slots = Array.isArray(p.rosterSlots) ? (p.rosterSlots as unknown[]).map((s) => String(s).toUpperCase()).filter((s) => SLOT_RE.test(s)) : null;
  let tz = base.timezone;
  if (typeof p.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: p.timezone });
      tz = p.timezone;
    } catch {
      /* keep */
    }
  }
  return {
    rosterSlots: slots && slots.length >= 5 && slots.length <= 16 ? slots : base.rosterSlots,
    benchSlots: int(p.benchSlots, 0, 10, base.benchSlots),
    ilSlots: int(p.ilSlots, 0, 6, base.ilSlots),
    weeklyAddLimit: int(p.weeklyAddLimit, 0, 99, base.weeklyAddLimit),
    lineupLock: p.lineupLock === "weekly" ? "weekly" : p.lineupLock === "daily" ? "daily" : base.lineupLock,
    playoffWeeks: int(p.playoffWeeks, 0, 8, base.playoffWeeks),
    timezone: tz,
    fetchFreeAgentPages: typeof p.fetchFreeAgentPages === "boolean" ? p.fetchFreeAgentPages : base.fetchFreeAgentPages,
  };
}

export interface LeagueInfo {
  id: number;
  yahooLeagueKey: string | null;
  name: string;
  teams: number;
  sourceDraftId: number | null;
  settings: SeasonSettings;
  userSlot: number;
  createdAt: string;
  updatedAt: string;
}

export function getLeague(db: Db, id?: number): LeagueInfo | null {
  const row = id === undefined ? db.select().from(league).orderBy(desc(league.id)).limit(1).get() : db.select().from(league).where(eq(league.id, id)).get();
  if (!row) return null;
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.settings);
  } catch {
    /* defaults */
  }
  const user = db.select().from(leagueTeam).where(and(eq(leagueTeam.leagueId, row.id), eq(leagueTeam.isUser, true))).get();
  return { id: row.id, yahooLeagueKey: row.yahooLeagueKey, name: row.name, teams: row.teams, sourceDraftId: row.sourceDraftId, settings: sanitizeSettings(parsed), userSlot: user?.slot ?? 0, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function updateSettings(db: Db, leagueId: number, patch: unknown): SeasonSettings {
  const lg = getLeague(db, leagueId);
  if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", `League ${leagueId} not found`);
  const next = sanitizeSettings(patch, lg.settings);
  db.update(league).set({ settings: JSON.stringify(next), updatedAt: new Date().toISOString() }).where(eq(league.id, leagueId)).run();
  return next;
}

export interface TeamInfo { slot: number; name: string; isUser: boolean; yahooTeamId: string | null }
export function getTeams(db: Db, leagueId: number): TeamInfo[] {
  return db.select().from(leagueTeam).where(eq(leagueTeam.leagueId, leagueId)).orderBy(leagueTeam.slot).all().map((t) => ({ slot: t.slot, name: t.yahooName, isUser: t.isUser, yahooTeamId: t.yahooTeamId }));
}

export interface RosterRow { playerId: string; teamSlot: number; lineupSlot: string | null; status: "active" | "bench" | "il"; acquiredAt: string; source: "draft" | "yahoo-page" | "manual" | "transaction" }
export function getRosters(db: Db, leagueId: number): Map<number, RosterRow[]> {
  const out = new Map<number, RosterRow[]>();
  for (const r of db.select().from(leagueRoster).where(eq(leagueRoster.leagueId, leagueId)).orderBy(leagueRoster.id).all()) {
    const list = out.get(r.teamSlot) ?? [];
    list.push({ playerId: r.playerId, teamSlot: r.teamSlot, lineupSlot: r.lineupSlot, status: r.status, acquiredAt: r.acquiredAt, source: r.source });
    out.set(r.teamSlot, list);
  }
  return out;
}

/**
 * Bootstraps a league from a (finished) draft: league row, teams (Yahoo names from draft_team), every team's roster = its picks,
 * and an initial roster snapshot per team. Idempotent per draft: a second call returns the existing league (unless `reset`, which
 * replaces the rosters by the draft's picks again and keeps the settings).
 */
export function createLeagueFromDraft(db: Db, draftId: number, opts: { reset?: boolean; name?: string; settings?: Partial<SeasonSettings>; now?: string } = {}): { league: LeagueInfo; created: boolean } {
  const now = opts.now ?? new Date().toISOString();
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new SeasonError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
  const existing = db.select().from(league).where(eq(league.sourceDraftId, draftId)).get();
  if (existing && !opts.reset) return { league: getLeague(db, existing.id)!, created: false };
  const meta = db.select().from(draftMeta).where(eq(draftMeta.draftId, draftId)).get();
  const names = new Map(db.select().from(draftTeam).where(eq(draftTeam.draftId, draftId)).all().map((t) => [t.teamSlot, t]));
  const picks = db.select().from(draftPicks).where(eq(draftPicks.draftId, draftId)).orderBy(draftPicks.pick).all();

  return db.transaction((tx) => {
    let id: number;
    if (existing) {
      id = existing.id;
      tx.delete(leagueRoster).where(eq(leagueRoster.leagueId, id)).run();
      tx.delete(leagueTeam).where(eq(leagueTeam.leagueId, id)).run();
    } else {
      const settings = sanitizeSettings(opts.settings ?? {});
      id = tx.insert(league).values({ yahooLeagueKey: meta?.yahooRoomKey ?? null, name: opts.name ?? meta?.leagueName ?? `Draft ${draftId} league`, teams: draft.teams, sourceDraftId: draftId, settings: JSON.stringify(settings), createdAt: now, updatedAt: now }).returning({ id: league.id }).get().id;
    }
    for (let slot = 1; slot <= draft.teams; slot++) {
      const t = names.get(slot);
      tx.insert(leagueTeam).values({ leagueId: id, slot, yahooName: t?.yahooTeamName ?? `Team ${slot}`, isUser: slot === draft.userSlot }).run();
    }
    const bySlot = new Map<number, { playerId: string; lineupSlot: null; status: "active" }[]>();
    for (const p of picks) {
      tx.insert(leagueRoster).values({ leagueId: id, teamSlot: p.teamSlot, playerId: p.playerId, lineupSlot: null, status: "active", acquiredAt: p.timestamp || now, source: "draft" }).run();
      (bySlot.get(p.teamSlot) ?? bySlot.set(p.teamSlot, []).get(p.teamSlot)!).push({ playerId: p.playerId, lineupSlot: null, status: "active" });
    }
    for (let slot = 1; slot <= draft.teams; slot++) tx.insert(rosterSnapshots).values({ leagueId: id, teamSlot: slot, capturedAt: now, source: "draft", payload: JSON.stringify(bySlot.get(slot) ?? []) }).run();
    return { league: getLeague(tx as unknown as Db, id)!, created: !existing };
  });
}

export interface RosterSyncEntry { playerId: string; lineupSlot: string | null; status: "active" | "bench" | "il" }
export interface RosterSyncResult { added: string[]; dropped: string[]; moved: string[]; unchanged: number; snapshotId: number }

/**
 * Replaces one team's roster by what a Yahoo page (or a manual edit) shows. Players that join the team are `added` (and leave any other
 * team they were on: `moved`), players that vanish are `dropped`. acquired_at / source are kept for players that stay.
 */
export function syncTeamRoster(db: Db, leagueId: number, teamSlot: number, entries: readonly RosterSyncEntry[], source: "yahoo-page" | "manual", now = new Date().toISOString()): RosterSyncResult {
  const team = db.select().from(leagueTeam).where(and(eq(leagueTeam.leagueId, leagueId), eq(leagueTeam.slot, teamSlot))).get();
  if (!team) throw new SeasonError("TEAM_NOT_FOUND", `Team ${teamSlot} not found in league ${leagueId}`);
  return db.transaction((tx) => {
    const cur = new Map(tx.select().from(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.teamSlot, teamSlot))).all().map((r) => [r.playerId, r]));
    const want = new Map(entries.map((e) => [e.playerId, e]));
    const added: string[] = [];
    const moved: string[] = [];
    const dropped = [...cur.keys()].filter((id) => !want.has(id));
    if (dropped.length) tx.delete(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.teamSlot, teamSlot), inArray(leagueRoster.playerId, dropped))).run();
    let unchanged = 0;
    for (const e of want.values()) {
      const have = cur.get(e.playerId);
      if (have) {
        unchanged++;
        tx.update(leagueRoster).set({ lineupSlot: e.lineupSlot, status: e.status }).where(eq(leagueRoster.id, have.id)).run();
        continue;
      }
      const elsewhere = tx.select().from(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.playerId, e.playerId))).get();
      if (elsewhere) {
        moved.push(e.playerId);
        tx.delete(leagueRoster).where(eq(leagueRoster.id, elsewhere.id)).run();
      }
      added.push(e.playerId);
      tx.insert(leagueRoster).values({ leagueId, teamSlot, playerId: e.playerId, lineupSlot: e.lineupSlot, status: e.status, acquiredAt: now, source }).run();
    }
    const snap = tx.insert(rosterSnapshots).values({ leagueId, teamSlot, capturedAt: now, source, payload: JSON.stringify(entries) }).returning({ id: rosterSnapshots.id }).get();
    tx.update(league).set({ updatedAt: now }).where(eq(league.id, leagueId)).run();
    return { added, dropped, moved, unchanged, snapshotId: snap.id };
  });
}

export function latestSnapshot(db: Db, leagueId: number, teamSlot: number): { id: number; capturedAt: string; source: string; payload: RosterSyncEntry[] } | null {
  const r = db.select().from(rosterSnapshots).where(and(eq(rosterSnapshots.leagueId, leagueId), eq(rosterSnapshots.teamSlot, teamSlot))).orderBy(desc(rosterSnapshots.id)).limit(1).get();
  if (!r) return null;
  let payload: RosterSyncEntry[] = [];
  try {
    payload = JSON.parse(r.payload);
  } catch {
    /* empty */
  }
  return { id: r.id, capturedAt: r.capturedAt, source: r.source, payload };
}

/** Latest roster sync that came from a Yahoo page (not the draft bootstrap) for a team. */
export function lastYahooSync(db: Db, leagueId: number, teamSlot: number): string | null {
  const r = db.select({ at: rosterSnapshots.capturedAt }).from(rosterSnapshots).where(and(eq(rosterSnapshots.leagueId, leagueId), eq(rosterSnapshots.teamSlot, teamSlot), eq(rosterSnapshots.source, "yahoo-page"))).orderBy(desc(rosterSnapshots.id)).limit(1).get();
  return r?.at ?? null;
}

export function setTeamYahooId(db: Db, leagueId: number, teamSlot: number, yahooTeamId: string): void {
  db.update(leagueTeam).set({ yahooTeamId }).where(and(eq(leagueTeam.leagueId, leagueId), eq(leagueTeam.slot, teamSlot))).run();
}

// ----------------------------------------------------------------------------------------------- free agents

export interface FreeAgentRow { yahooId: string; playerId: string | null; name: string; nbaTeam: string | null; positions: string | null; pctOwned: number | null; injuryTag: string | null; stats: Record<string, number> | null; capturedAt: string }

export function upsertFreeAgents(db: Db, leagueId: number, rows: readonly FreeAgentRow[]): number {
  return db.transaction((tx) => {
    for (const r of rows) {
      const v = { leagueId, yahooId: r.yahooId, playerId: r.playerId, name: r.name, nbaTeam: r.nbaTeam, positions: r.positions, pctOwned: r.pctOwned, injuryTag: r.injuryTag, stats: r.stats ? JSON.stringify(r.stats) : null, capturedAt: r.capturedAt };
      tx.insert(leagueFreeAgents).values(v).onConflictDoUpdate({ target: [leagueFreeAgents.leagueId, leagueFreeAgents.yahooId], set: { playerId: v.playerId, name: v.name, nbaTeam: v.nbaTeam, positions: v.positions, pctOwned: v.pctOwned, injuryTag: v.injuryTag, stats: v.stats, capturedAt: v.capturedAt } }).run();
    }
    return rows.length;
  });
}

export function loadFreeAgents(db: Db, leagueId: number): FreeAgentRow[] {
  return db.select().from(leagueFreeAgents).where(eq(leagueFreeAgents.leagueId, leagueId)).all().map((r) => ({
    yahooId: r.yahooId, playerId: r.playerId, name: r.name, nbaTeam: r.nbaTeam, positions: r.positions, pctOwned: r.pctOwned, injuryTag: r.injuryTag, stats: r.stats ? (JSON.parse(r.stats) as Record<string, number>) : null, capturedAt: r.capturedAt,
  }));
}

// ----------------------------------------------------------------------------------------------- state + briefs

export function getState<T>(db: Db, leagueId: number, key: string): { value: T; updatedAt: string } | null {
  const r = db.select().from(leagueState).where(and(eq(leagueState.leagueId, leagueId), eq(leagueState.key, key))).get();
  if (!r) return null;
  try {
    return { value: JSON.parse(r.value) as T, updatedAt: r.updatedAt };
  } catch {
    return null;
  }
}

export function setState(db: Db, leagueId: number, key: string, value: unknown, now = new Date().toISOString()): void {
  const v = JSON.stringify(value);
  db.insert(leagueState).values({ leagueId, key, value: v, updatedAt: now }).onConflictDoUpdate({ target: [leagueState.leagueId, leagueState.key], set: { value: v, updatedAt: now } }).run();
}

/** Weekly add counter: detected adds from roster syncs plus a manual override. */
export interface AddsState { count: number; override: number | null; log: { playerId: string; at: string; source: string }[] }
export const addsKey = (weekStart: string) => `adds:${weekStart}`;
export function getAdds(db: Db, leagueId: number, weekStart: string): AddsState {
  return getState<AddsState>(db, leagueId, addsKey(weekStart))?.value ?? { count: 0, override: null, log: [] };
}
export function recordAdds(db: Db, leagueId: number, weekStart: string, playerIds: readonly string[], source: string, now = new Date().toISOString()): AddsState {
  const s = getAdds(db, leagueId, weekStart);
  // The same add can be seen twice (transactions page + roster page): count a player once per week.
  const fresh = playerIds.filter((id) => !s.log.some((l) => l.playerId === id));
  for (const id of fresh) s.log.push({ playerId: id, at: now, source });
  s.count += fresh.length;
  setState(db, leagueId, addsKey(weekStart), s, now);
  return s;
}
export function setAddsOverride(db: Db, leagueId: number, weekStart: string, used: number | null): AddsState {
  const s = getAdds(db, leagueId, weekStart);
  s.override = used;
  setState(db, leagueId, addsKey(weekStart), s);
  return s;
}
export const addsUsed = (s: AddsState): number => (s.override ?? s.count);

export function getBrief<T>(db: Db, leagueId: number, day: string): { payload: T; createdAt: string } | null {
  const r = db.select().from(seasonBriefs).where(and(eq(seasonBriefs.leagueId, leagueId), eq(seasonBriefs.day, day))).get();
  if (!r) return null;
  try {
    return { payload: JSON.parse(r.payload) as T, createdAt: r.createdAt };
  } catch {
    return null;
  }
}
export function saveBrief(db: Db, leagueId: number, day: string, payload: unknown, now = new Date().toISOString()): void {
  const p = JSON.stringify(payload);
  db.insert(seasonBriefs).values({ leagueId, day, payload: p, createdAt: now }).onConflictDoUpdate({ target: [seasonBriefs.leagueId, seasonBriefs.day], set: { payload: p, createdAt: now } }).run();
}

// ----------------------------------------------------------------------------------------------- transactions + sync meta

export interface TxnAction { action: "add" | "drop" | "trade"; yahooId: string; name: string; playerId: string | null; teamSlot: number | null; teamName?: string }
export interface TxnRow { id: number; key: string; kind: string; occurredOn: string | null; occurredTime: string | null; actions: TxnAction[]; applied: boolean; createdAt: string }

export function getTransactions(db: Db, leagueId: number): TxnRow[] {
  return db.select().from(leagueTransactions).where(eq(leagueTransactions.leagueId, leagueId)).orderBy(desc(leagueTransactions.occurredOn), desc(leagueTransactions.id)).all().map((r) => {
    let actions: TxnAction[] = [];
    try {
      actions = JSON.parse(r.actions);
    } catch {
      /* empty */
    }
    return { id: r.id, key: r.key, kind: r.kind, occurredOn: r.occurredOn, occurredTime: r.occurredTime, actions, applied: r.applied, createdAt: r.createdAt };
  });
}

/** Inserts a transaction unless its key exists. Returns the new row id or null when it was already known. */
export function insertTransaction(db: Db, leagueId: number, t: { key: string; kind: string; occurredOn: string | null; occurredTime: string | null; actions: TxnAction[] }, now: string): number | null {
  const r = db.insert(leagueTransactions).values({ leagueId, key: t.key, kind: t.kind, occurredOn: t.occurredOn, occurredTime: t.occurredTime, actions: JSON.stringify(t.actions), applied: false, createdAt: now }).onConflictDoNothing().returning({ id: leagueTransactions.id }).get();
  return r?.id ?? null;
}
export function markTransactionApplied(db: Db, id: number): void {
  db.update(leagueTransactions).set({ applied: true }).where(eq(leagueTransactions.id, id)).run();
}

/** Incremental roster change (transactions): drops then adds on one team; an added player leaves any other team. Keeps a snapshot for history. */
export function applyRosterMoves(db: Db, leagueId: number, teamSlot: number, moves: { add: string[]; drop: string[] }, now: string): { added: string[]; dropped: string[] } {
  return db.transaction((tx) => {
    const cur = tx.select().from(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.teamSlot, teamSlot))).all();
    const dropped: string[] = [];
    for (const id of moves.drop) {
      const row = cur.find((r) => r.playerId === id);
      if (!row) continue;
      tx.delete(leagueRoster).where(eq(leagueRoster.id, row.id)).run();
      dropped.push(id);
    }
    const added: string[] = [];
    for (const id of moves.add) {
      if (cur.some((r) => r.playerId === id && !dropped.includes(id))) continue;
      tx.delete(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.playerId, id))).run();
      tx.insert(leagueRoster).values({ leagueId, teamSlot, playerId: id, lineupSlot: "BN", status: "bench", acquiredAt: now, source: "transaction" }).run();
      added.push(id);
    }
    if (added.length || dropped.length) {
      const after = tx.select().from(leagueRoster).where(and(eq(leagueRoster.leagueId, leagueId), eq(leagueRoster.teamSlot, teamSlot))).all();
      tx.insert(rosterSnapshots).values({ leagueId, teamSlot, capturedAt: now, source: "transaction", payload: JSON.stringify(after.map((r) => ({ playerId: r.playerId, lineupSlot: r.lineupSlot, status: r.status }))) }).run();
    }
    return { added, dropped };
  });
}

/** Per team: when a Yahoo roster page was last read (ISO) - transactions older than that are already reflected. */
export function lastYahooSyncByTeam(db: Db, leagueId: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of db.select({ slot: rosterSnapshots.teamSlot, at: rosterSnapshots.capturedAt }).from(rosterSnapshots).where(and(eq(rosterSnapshots.leagueId, leagueId), eq(rosterSnapshots.source, "yahoo-page"))).all()) {
    if (!out.has(r.slot) || out.get(r.slot)! < r.at) out.set(r.slot, r.at);
  }
  return out;
}
