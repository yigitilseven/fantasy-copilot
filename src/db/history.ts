import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { DRAFT_KINDS, draftMeta, draftPickContext, draftPicks, draftStandings, draftTeam, drafts, modelParams, playerMarket, yahooProjections, type DraftKind } from "./schema";
import type { AnalysisDraft } from "@/engine/analysis/types";
import type { OpponentModelParams } from "@/types";

/**
 * Draft history persistence (all writes append/upsert only, nothing here deletes picks). Everything called from the live
 * ingestion path is wrapped by the caller in try/catch: history must never block or fail ingestion.
 */

export { DRAFT_KINDS };
export type { DraftKind };

const UNKNOWN_PLACEHOLDER = "yahoo-unknown-%";

/** Kind derived from the picks: damaged (>10% unknown placeholders) > yahoo-live (>= 50% yahoo-dom) > mock-bots (>= 50% simulation) > manual. */
export function classifyDraftKind(db: Db, draftId: number): DraftKind {
  const rows = db
    .select({ source: draftPicks.source, n: sql<number>`count(*)`, unknown: sql<number>`sum(case when ${draftPicks.playerId} like ${UNKNOWN_PLACEHOLDER} then 1 else 0 end)` })
    .from(draftPicks)
    .where(eq(draftPicks.draftId, draftId))
    .groupBy(draftPicks.source)
    .all();
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return "manual";
  const by = (s: string) => rows.find((r) => r.source === s)?.n ?? 0;
  const unknown = rows.reduce((a, r) => a + (r.unknown ?? 0), 0);
  const yahoo = by("yahoo-dom") + by("yahoo");
  if (unknown / total > 0.1) return "damaged";
  if (yahoo / total >= 0.5) return "yahoo-live";
  if (by("simulation") / total >= 0.5) return "mock-bots";
  return "manual";
}

export interface MetaPatch {
  yahooRoomKey?: string | null;
  leagueName?: string | null;
  finishedAt?: string | null;
  /** Force a kind instead of deriving it. */
  kind?: DraftKind;
}

/** Creates/refreshes draft_meta: the kind is re-derived from the picks; room key / league name / finished_at are only ever filled in, never blanked. */
export function ensureDraftMeta(db: Db, draftId: number, patch: MetaPatch = {}): void {
  const d = db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (!d) return;
  const cur = db.select().from(draftMeta).where(eq(draftMeta.draftId, draftId)).get();
  const kind = patch.kind ?? classifyDraftKind(db, draftId);
  const finishedAt = cur?.finishedAt ?? patch.finishedAt ?? (d.status === "complete" ? new Date().toISOString() : null);
  const values = {
    kind,
    yahooRoomKey: patch.yahooRoomKey ?? cur?.yahooRoomKey ?? null,
    leagueName: patch.leagueName ?? cur?.leagueName ?? null,
    finishedAt,
  };
  if (cur) db.update(draftMeta).set(values).where(eq(draftMeta.draftId, draftId)).run();
  else db.insert(draftMeta).values({ draftId, ...values }).run();
}

/** Upserts Yahoo team names per draft slot. */
export function recordTeams(db: Db, draftId: number, teams: { slot: number; name: string; isUser?: boolean }[]): void {
  for (const t of teams) {
    const name = t.name.trim().slice(0, 120);
    if (!name || !(t.slot >= 1)) continue;
    const cur = db.select().from(draftTeam).where(and(eq(draftTeam.draftId, draftId), eq(draftTeam.teamSlot, t.slot))).get();
    if (cur) db.update(draftTeam).set({ yahooTeamName: name, isUser: t.isUser ?? cur.isUser }).where(and(eq(draftTeam.draftId, draftId), eq(draftTeam.teamSlot, t.slot))).run();
    else db.insert(draftTeam).values({ draftId, teamSlot: t.slot, yahooTeamName: name, isUser: t.isUser ?? false }).run();
  }
}

export interface StandingsRowInput {
  rank: number;
  teamName: string;
  fg?: number; ft?: number; threePm?: number; pts?: number; reb?: number; ast?: number; stl?: number; blk?: number; tov?: number; total?: number;
}

/** Replaces the rows of one standings view of a draft (a later capture of the same view wins). */
export function recordStandings(db: Db, draftId: number, view: string, rows: StandingsRowInput[], capturedAt = new Date().toISOString()): number {
  if (!rows.length) return 0;
  db.transaction((tx) => {
    tx.delete(draftStandings).where(and(eq(draftStandings.draftId, draftId), eq(draftStandings.view, view))).run();
    for (const r of rows) {
      tx.insert(draftStandings)
        .values({ draftId, view, teamName: r.teamName, rank: r.rank, fg: r.fg ?? null, ft: r.ft ?? null, threePm: r.threePm ?? null, pts: r.pts ?? null, reb: r.reb ?? null, ast: r.ast ?? null, stl: r.stl ?? null, blk: r.blk ?? null, tov: r.tov ?? null, total: r.total ?? null, capturedAt })
        .onConflictDoNothing()
        .run();
    }
  });
  return rows.length;
}

export interface PickContextInput {
  pick: number;
  yahooId?: string | null;
  teamName?: string | null;
}

/** Looks up what the app knew about a pick before it was made (cached recommendations only; never computes). */
export type RankPeek = (draftId: number, pick: number, playerId: string) => { rank: number; state: string; available: number } | null;

/**
 * For every recorded pick without a context row: ADP of the player now in player_market (the ADP "at pick time" as far as we
 * can tell: this runs when the pick is ingested), the cached recommendation rank/state when the app had them, the available
 * count, plus the payload's yahoo id / team name. Existing rows are only completed (null team/id), never overwritten.
 * Also fills draft_team (team name by snake slot) from the payload. Safe to call repeatedly.
 */
export function recordPickContext(db: Db, draftId: number, payload: PickContextInput[], opts: { peek?: RankPeek; teams: number }): void {
  const d = db.select({ teams: drafts.teams, rounds: drafts.rounds }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (!d) return;
  const recorded = db
    // ADP at pick = Yahoo's draft-room ADP (captured) when known; the imported market ADP disagrees badly with Yahoo.
    .select({ pick: draftPicks.pick, teamSlot: draftPicks.teamSlot, playerId: draftPicks.playerId, adp: sql<number | null>`coalesce(${yahooProjections.adp}, ${playerMarket.yahooAdp})` })
    .from(draftPicks)
    .leftJoin(playerMarket, eq(playerMarket.playerId, draftPicks.playerId))
    .leftJoin(yahooProjections, eq(yahooProjections.playerId, draftPicks.playerId))
    .where(eq(draftPicks.draftId, draftId))
    .all();
  const byPick = new Map(recorded.map((r) => [r.pick, r]));
  const existing = new Map(db.select().from(draftPickContext).where(eq(draftPickContext.draftId, draftId)).all().map((r) => [r.pick, r]));
  const payloadBy = new Map(payload.map((p) => [p.pick, p]));
  const teamNames = new Map<number, string>();
  for (const [pickNo, r] of byPick) {
    const p = payloadBy.get(pickNo);
    const cur = existing.get(pickNo);
    if (p?.teamName) teamNames.set(r.teamSlot, p.teamName);
    if (cur) {
      if ((!cur.teamName && p?.teamName) || (!cur.yahooId && p?.yahooId))
        db.update(draftPickContext).set({ teamName: cur.teamName ?? p?.teamName ?? null, yahooId: cur.yahooId ?? p?.yahooId ?? null }).where(and(eq(draftPickContext.draftId, draftId), eq(draftPickContext.pick, pickNo))).run();
      continue;
    }
    let peeked: ReturnType<RankPeek> = null;
    try {
      peeked = opts.peek ? opts.peek(draftId, pickNo, r.playerId) : null;
    } catch {
      peeked = null;
    }
    const availableCount = peeked?.available ?? null;
    db.insert(draftPickContext)
      .values({ draftId, pick: pickNo, adpAtPick: r.adp ?? null, ourRankAtPick: peeked?.rank ?? null, ourStateAtPick: peeked?.state ?? null, availableCount, yahooId: p?.yahooId ?? null, teamName: p?.teamName ?? null })
      .onConflictDoNothing()
      .run();
  }
  if (teamNames.size) recordTeams(db, draftId, [...teamNames].map(([slot, name]) => ({ slot, name })));
}

/** Drops context rows of picks that no longer exist or were rewound (>= fromPick). */
export function deleteContextFrom(db: Db, draftId: number, fromPick: number): void {
  db.delete(draftPickContext).where(and(eq(draftPickContext.draftId, draftId), gte(draftPickContext.pick, fromPick))).run();
}

/** All writes the live ingest path performs, never throwing. */
export function recordIngestHistory(db: Db, draftId: number, payload: PickContextInput[], opts: { peek?: RankPeek; roomKey?: string | null; leagueName?: string | null } = {}): void {
  try {
    const d = db.select({ teams: drafts.teams }).from(drafts).where(eq(drafts.id, draftId)).get();
    if (!d) return;
    recordPickContext(db, draftId, payload, { peek: opts.peek, teams: d.teams });
    ensureDraftMeta(db, draftId, { yahooRoomKey: opts.roomKey ?? null, leagueName: opts.leagueName ?? null });
  } catch (e) {
    console.error("[history] recordIngestHistory failed (ingestion unaffected):", e);
  }
}

// ------------------------------------------------------------------------------------------------------ reads

export interface DraftSummary {
  id: number;
  createdAt: string;
  teams: number;
  rounds: number;
  userSlot: number;
  status: string;
  picks: number;
  kind: DraftKind;
  leagueName: string | null;
  finishedAt: string | null;
  /** The user's team name (draft_team.is_user) when known. */
  userTeam: string | null;
  /** The user's standings rank by view, when captured. */
  ranks: Record<string, { rank: number; total: number | null }>;
}

export function listDraftSummaries(db: Db): DraftSummary[] {
  const rows = db.select().from(drafts).orderBy(asc(drafts.id)).all();
  const counts = new Map(db.select({ id: draftPicks.draftId, n: sql<number>`count(*)` }).from(draftPicks).groupBy(draftPicks.draftId).all().map((r) => [r.id, r.n]));
  const metas = new Map(db.select().from(draftMeta).all().map((m) => [m.draftId, m]));
  const userTeams = new Map(db.select().from(draftTeam).where(eq(draftTeam.isUser, true)).all().map((t) => [t.draftId, t.yahooTeamName]));
  const standings = db.select().from(draftStandings).all();
  return rows
    .map((d) => {
      const meta = metas.get(d.id);
      const userTeam = userTeams.get(d.id) ?? null;
      const ranks: DraftSummary["ranks"] = {};
      if (userTeam) for (const s of standings) if (s.draftId === d.id && s.teamName === userTeam) ranks[s.view] = { rank: s.rank, total: s.total };
      return {
        id: d.id, createdAt: d.createdAt, teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, status: d.status, picks: counts.get(d.id) ?? 0,
        kind: ((meta?.kind as DraftKind | undefined) ?? classifyDraftKind(db, d.id)), leagueName: meta?.leagueName ?? null, finishedAt: meta?.finishedAt ?? null, userTeam, ranks,
      };
    })
    .reverse();
}

/** Picks + team names of one draft in analysis form (ADP at pick time from the context when recorded). */
export function loadAnalysisDraft(db: Db, draftId: number): AnalysisDraft | null {
  const d = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!d) return null;
  const ctx = new Map(db.select().from(draftPickContext).where(eq(draftPickContext.draftId, draftId)).all().map((c) => [c.pick, c]));
  const picks = db.select().from(draftPicks).where(eq(draftPicks.draftId, draftId)).orderBy(asc(draftPicks.pick)).all();
  const teamNames: Record<number, string> = {};
  for (const t of db.select().from(draftTeam).where(eq(draftTeam.draftId, draftId)).all()) teamNames[t.teamSlot] = t.yahooTeamName;
  for (const c of ctx.values()) {
    const p = picks.find((x) => x.pick === c.pick);
    if (p && c.teamName && !teamNames[p.teamSlot]) teamNames[p.teamSlot] = c.teamName;
  }
  return {
    id: d.id, teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, teamNames,
    picks: picks.map((p) => ({ pick: p.pick, round: p.round, teamSlot: p.teamSlot, playerId: p.playerId, adpAtPick: ctx.get(p.pick)?.adpAtPick ?? null })),
  };
}

/** Ids of drafts the analytics use: clean yahoo-live drafts only. */
export function cleanDraftIds(db: Db): number[] {
  return listDraftSummaries(db).filter((s) => s.kind === "yahoo-live").map((s) => s.id).sort((a, b) => a - b);
}

export function loadStandings(db: Db, draftId: number) {
  return db.select().from(draftStandings).where(eq(draftStandings.draftId, draftId)).orderBy(asc(draftStandings.view), asc(draftStandings.rank)).all();
}

export function loadTeams(db: Db, draftId: number) {
  return db.select().from(draftTeam).where(eq(draftTeam.draftId, draftId)).orderBy(asc(draftTeam.teamSlot)).all();
}

// ------------------------------------------------------------------------------------------------------ model params

export const OPPONENT_MODEL = "opponent";

export interface StoredModel extends OpponentModelParams {
  enabled: boolean;
  fittedAt: string;
  detail?: unknown;
}

export function saveOpponentModel(db: Db, params: OpponentModelParams, detail?: unknown, enabled?: boolean): void {
  const cur = db.select().from(modelParams).where(eq(modelParams.name, OPPONENT_MODEL)).get();
  const value = JSON.stringify({ k: params.k, autopickShare: params.autopickShare, detail });
  const values = { value, enabled: enabled ?? cur?.enabled ?? false, fittedAt: new Date().toISOString() };
  if (cur) db.update(modelParams).set(values).where(eq(modelParams.name, OPPONENT_MODEL)).run();
  else db.insert(modelParams).values({ name: OPPONENT_MODEL, ...values }).run();
}

export function setOpponentModelEnabled(db: Db, enabled: boolean): boolean {
  return db.update(modelParams).set({ enabled }).where(eq(modelParams.name, OPPONENT_MODEL)).returning({ n: modelParams.name }).all().length > 0;
}

/** The stored fit (enabled or not); null when none or the table is unavailable. */
export function loadStoredModel(db: Db): StoredModel | null {
  try {
    const r = db.select().from(modelParams).where(eq(modelParams.name, OPPONENT_MODEL)).get();
    if (!r) return null;
    const v = JSON.parse(r.value) as { k: number; autopickShare: number; detail?: unknown };
    return { k: v.k, autopickShare: v.autopickShare, detail: v.detail, enabled: r.enabled, fittedAt: r.fittedAt };
  } catch {
    return null;
  }
}

/** The parameters the simulator should use: only when a fit exists AND is enabled; undefined = defaults (unchanged behaviour). Never throws. */
export function activeOpponentModel(db: Db): OpponentModelParams | undefined {
  const m = loadStoredModel(db);
  return m && m.enabled && m.k > 0 ? { k: m.k, autopickShare: m.autopickShare } : undefined;
}
