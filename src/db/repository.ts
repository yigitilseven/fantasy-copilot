import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { activeOpponentModel } from "./history";
import { draftPicks, drafts, playerMarket, playerNews, playerProjections, playerRisk, playerStatusUpdates, players, yahooProjections } from "./schema";
import { applyStatusUpdate, type StatusUpdate } from "@/engine/risk/status";
import { computeValuations } from "@/engine/valuation/value";
import { pickForOpponent } from "@/engine/draft/opponent";
import { createRng } from "@/engine/draft/rng";
import { applyStrategyPatch, parseStrategy, type StrategyPatch } from "@/engine/recommendation/strategy";
import { mergeYahooMarket, mergeYahooProjection } from "@/integrations/yahoo/projection-merge";
import { defaultStatsCacheDir, loadPlayerIndexMeta, loadSeasonStats } from "@/integrations/projections/stats-lookup";
import { averageLines, fpLine, loadFantasyProsProjections } from "@/integrations/projections/fantasypros-projections";
import { nameKey } from "@/integrations/projections/names";
import { applyProjectionBlend, canonicalTeam, lineOf } from "@/engine/projection/blend";
import type { DraftPick, DraftState, InjuryStatus, PickSource, PlayerNewsItem, Position, PlayerRecord, ProjectionLine } from "../types";

export type DraftErrorCode =
  | "DRAFT_NOT_FOUND"
  | "DRAFT_COMPLETE"
  | "PLAYER_NOT_FOUND"
  | "PLAYER_ALREADY_DRAFTED"
  | "NO_PICKS_TO_UNDO"
  | "INVALID_CONFIG";

export class DraftError extends Error {
  constructor(
    public readonly code: DraftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

/** Snake order: odd rounds ascending, even rounds descending. 1-based pick → round/teamSlot. */
function snakePosition(pick: number, teams: number): { round: number; teamSlot: number } {
  const round = Math.floor((pick - 1) / teams) + 1;
  const idx = (pick - 1) % teams;
  return { round, teamSlot: round % 2 === 1 ? idx + 1 : teams - idx };
}

/** Latest status update + latest 3 headlines per player. Empty (never throws) when the news tables are missing/unreadable. */
export function loadNewsOverlay(db: Db): { status: Map<string, StatusUpdate>; news: Map<string, PlayerNewsItem[]> } {
  const status = new Map<string, StatusUpdate>();
  const news = new Map<string, PlayerNewsItem[]>();
  try {
    const latest = db
      .select()
      .from(playerStatusUpdates)
      .where(inArray(playerStatusUpdates.id, sql`(select max(id) from player_status_updates group by player_id)`))
      .all();
    for (const u of latest)
      status.set(u.playerId, { status: u.status as InjuryStatus, injury: u.injury, estReturnDate: u.estReturnDate, source: u.source, reportedAt: u.reportedAt });
    for (const n of db.select().from(playerNews).orderBy(desc(playerNews.publishedAt)).limit(3000).all()) {
      const list = news.get(n.playerId) ?? [];
      if (list.length < 3) {
        list.push({ title: n.title, link: n.link, source: n.source, publishedAt: n.publishedAt });
        news.set(n.playerId, list);
      }
    }
  } catch {
    // news tables unavailable (e.g. a connection opened before the migration): plain CSV risk
  }
  return { status, news };
}

/** The season Yahoo's captured projections must belong to for the overlay to apply. */
export const YAHOO_PROJECTION_SEASON = "2026-27";

/** Yahoo 2026-27 projections by local player id (matched rows only). Empty (never throws) when the table is missing. */
export function loadYahooProjectionOverlay(db: Db): Map<string, typeof yahooProjections.$inferSelect> {
  const out = new Map<string, typeof yahooProjections.$inferSelect>();
  try {
    for (const r of db.select().from(yahooProjections).where(eq(yahooProjections.season, YAHOO_PROJECTION_SEASON)).all()) if (r.playerId) out.set(r.playerId, r);
  } catch {
    // table unavailable (connection opened before the migration): NBA.com projections only
  }
  return out;
}

/** The season whose real NBA.com per-game line is the "actual" side of the projection blend. */
export const ACTUAL_SEASON = "2025-26";
/** The season before ACTUAL_SEASON: per-36 shrinkage for small 2025-26 samples and the veteran/injury weight rules. */
export const PRIOR_SEASON = "2024-25";

export interface PlayerRecordOptions {
  /** NBA.com stats cache directory (default data/cache); injectable for tests. */
  statsCacheDir?: string;
  /**
   * When set, the Yahoo/2025-26 blend is applied: a fixed Yahoo weight, or "auto" for the per-player rate/volume split (see
   * engine/projection/blend.ts). Absent = the plain overlay (Yahoo when captured, else NBA.com); the records then still carry
   * `projection.components` so callers can blend.
   */
  projectionWeight?: number | "auto";
  /**
   * Opt-in: average the cached FantasyPros projections into the projection side. Default false = Yahoo only, because
   * the league is scored on Yahoo and Yahoo's projections are what the standings and the user's leaguemates see.
   */
  fantasyPros?: boolean;
  /** Attach `projection.components` (Yahoo + real 2025-26 lines) without blending. Implied by `projectionWeight`. */
  withComponents?: boolean;
}

export function getAllPlayerRecords(db: Db, now: number = Date.now(), opts: PlayerRecordOptions = {}): PlayerRecord[] {
  const overlay = loadNewsOverlay(db);
  const yahoo = loadYahooProjectionOverlay(db);
  const withComponents = opts.withComponents || opts.projectionWeight !== undefined;
  const cacheDir = opts.statsCacheDir ?? defaultStatsCacheDir();
  const season = withComponents ? loadSeasonStats(ACTUAL_SEASON, cacheDir) : null;
  const seasonPrev = withComponents ? loadSeasonStats(PRIOR_SEASON, cacheDir) : null;
  // FantasyPros' cache is an environment file like data/cache itself: tests that do not inject a cache dir must not see it.
  const fpIndex = withComponents && opts.fantasyPros === true && (opts.statsCacheDir || !process.env.VITEST) ? loadFantasyProsProjections(cacheDir) : null;
  const indexMeta = withComponents ? loadPlayerIndexMeta(cacheDir) : null;
  const rows = db
    .select()
    .from(players)
    .innerJoin(playerProjections, eq(playerProjections.playerId, players.id))
    .innerJoin(playerMarket, eq(playerMarket.playerId, players.id))
    .innerJoin(playerRisk, eq(playerRisk.playerId, players.id))
    .orderBy(playerMarket.rank)
    .all();
  const out = rows.map((r) => {
    const { player_projections: pj, player_market: m, player_risk: k, players: p } = r;
    const baseRisk = {
        playerId: k.playerId,
        projectedGames: k.projectedGames,
        currentStatus: k.currentStatus as InjuryStatus,
        injuryHistoryScore: k.injuryHistoryScore,
        restRisk: k.restRisk,
        availabilityScore: k.availabilityScore,
        majorInjuryHistory: k.majorInjuryHistory,
        updatedAt: k.updatedAt,
    };
    const upd = overlay.status.get(p.id);
    const nws = overlay.news.get(p.id) ?? [];
    const yp = yahoo.get(p.id);
    // Yahoo-created placeholders carry abbreviated names ("J. Butler Jr."): an initial + last-name match must also agree on the team,
    // or a namesake's (Jimmy Butler's) real stats would become the placeholder's "actual" line.
    const sameTeamRow = <T extends { team: string | null }>(row: T | null, skip = false): T | null =>
      row && !skip && p.id.startsWith("yahoo-") && canonicalTeam(row.team) !== canonicalTeam(p.nbaTeam) ? null : row;
    const risk = upd ? applyStatusUpdate(baseRisk, upd, nws, now) : nws.length ? { ...baseRisk, latestNews: nws } : baseRisk;
    const merged = (yp && mergeYahooProjection({ ...pj }, yp)) || { ...pj, projectionSource: "nba-stats" as const };
    // Real 2025-26 line: the NBA.com cache row (null = rookie / not found); when the cache file is missing entirely the
    // existing nba-stats projection stands in.
    let actual: ProjectionLine | null = null;
    let row25: ReturnType<NonNullable<typeof season>["find"]> = null;
    if (!withComponents) {
      // plain overlay only
    } else if (season) {
      row25 = sameTeamRow(season.find({ playerName: p.name, nbaTeam: p.nbaTeam }));
      const row = row25?.line;
      actual = row
        ? { games: row.gp, minutes: row.minutes ?? pj.minutes, pts: row.pts, fgm: row.fgm, fga: row.fga, ftm: row.ftm, fta: row.fta, threePm: row.threePm, reb: row.reb, ast: row.ast, stl: row.stl, blk: row.blk, tov: row.tov }
        : null;
    } else actual = lineOf(pj);
    const yahooLine = merged.projectionSource === "yahoo-2026-27" ? lineOf(merged) : null;
    let components: PlayerRecord["projection"]["components"];
    if (withComponents) {
      // 2024-25 line (same person as the 2025-26 row when we have one) and the 2026-27 forward-looking sources.
      const row24 = sameTeamRow(seasonPrev?.find({ playerName: row25?.name ?? p.name, nbaTeam: row25 ? null : p.nbaTeam }) ?? null, !!row25);
      const l24 = row24?.line.minutes ? { games: row24.line.gp, minutes: row24.line.minutes, pts: row24.line.pts, fgm: row24.line.fgm, fga: row24.line.fga, ftm: row24.line.ftm, fta: row24.line.fta, threePm: row24.line.threePm, reb: row24.line.reb, ast: row24.line.ast, stl: row24.line.stl, blk: row24.line.blk, tov: row24.line.tov } : null;
      const fpRow = fpIndex?.find({ playerName: p.name, nbaTeam: yp?.nbaTeam ?? p.nbaTeam }) ?? null;
      const fpL = fpRow ? fpLine(fpRow, actual) : null;
      const proj = yahooLine && fpL ? averageLines(yahooLine, fpL) : (yahooLine ?? fpL);
      components = {
        yahoo: yahooLine,
        actual,
        fantasyPros: fpL,
        projection: proj,
        actualPrev: l24,
        evidence: {
          age: p.age + 1,
          team26: canonicalTeam(yp?.nbaTeam ?? fpRow?.team),
          team25: canonicalTeam(row25?.team ?? (season ? null : p.nbaTeam)),
          team24: canonicalTeam(row24?.team),
          fromYear: indexMeta?.get(nameKey(p.name))?.fromYear ?? null,
        },
      };
    }
    return {
      player: {
        id: p.id,
        yahooPlayerKey: p.yahooPlayerKey,
        name: p.name,
        nbaTeam: p.nbaTeam,
        positions: p.positions.split("/") as Position[],
        age: p.age,
      },
      projection: components ? { ...merged, components } : merged,
      market: mergeYahooMarket(p.id, { playerId: m.playerId, yahooAdp: m.yahooAdp, adpStdDev: m.adpStdDev, rank: m.rank }, yp?.adp),
      risk,
    };
  });
  // A Yahoo ADP can replace a placeholder's rank: keep the list ordered by the effective rank (stable for ties).
  const ordered = yahoo.size ? out.sort((a, b) => a.market.rank - b.market.rank) : out;
  return opts.projectionWeight === undefined ? ordered : applyProjectionBlend(ordered, opts.projectionWeight);
}

function loadDraft(db: Db, id: number): DraftState | null {
  const d = db.select().from(drafts).where(eq(drafts.id, id)).get();
  if (!d) return null;
  const picks: DraftPick[] = db
    .select()
    .from(draftPicks)
    .where(eq(draftPicks.draftId, id))
    .orderBy(draftPicks.pick)
    .all()
    .map((p) => ({
      pick: p.pick,
      round: p.round,
      teamSlot: p.teamSlot,
      playerId: p.playerId,
      source: p.source,
      timestamp: p.timestamp,
    }));
  return { id: d.id, teams: d.teams, userSlot: d.userSlot, rounds: d.rounds, currentPick: d.currentPick, status: d.status, picks, strategy: parseStrategy(d.strategy) };
}

export function getDraft(db: Db, id: number): DraftState | null {
  return loadDraft(db, id);
}

/**
 * The newest draft, when it is still active; null otherwise. Older unfinished drafts are abandoned on purpose: once the
 * newest draft completes, a browser userscript still open on its (finished) room must not fall back to an older active
 * draft and overwrite its picks.
 */
export function getLatestActiveDraft(db: Db): DraftState | null {
  const d = db.select({ id: drafts.id, status: drafts.status }).from(drafts).orderBy(desc(drafts.id)).limit(1).get();
  return d && d.status === "active" ? loadDraft(db, d.id) : null;
}

export function createDraft(db: Db, input: { teams: number; userSlot: number; rounds: number }): DraftState {
  const { teams, userSlot, rounds } = input;
  if (!Number.isInteger(teams) || teams < 2 || !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(userSlot) || userSlot < 1 || userSlot > teams)
    throw new DraftError("INVALID_CONFIG", "Invalid draft configuration");
  const row = db.insert(drafts).values({ teams, userSlot, rounds, currentPick: 1, status: "active" }).returning({ id: drafts.id }).get();
  return loadDraft(db, row.id)!;
}

/** Applies a partial strategy update (see applyStrategyPatch) and returns the updated draft. */
export function updateDraftStrategy(db: Db, draftId: number, patch: StrategyPatch): DraftState {
  return db.transaction((tx) => {
    const d = tx.select().from(drafts).where(eq(drafts.id, draftId)).get();
    if (!d) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
    const next = applyStrategyPatch(parseStrategy(d.strategy), patch);
    tx.update(drafts).set({ strategy: JSON.stringify(next) }).where(eq(drafts.id, draftId)).run();
    return loadDraft(tx as unknown as Db, draftId)!;
  });
}

export function recordPick(db: Db, draftId: number, playerId: string, source: PickSource = "manual"): DraftState {
  return db.transaction((tx) => {
    const d = tx.select().from(drafts).where(eq(drafts.id, draftId)).get();
    if (!d) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
    if (d.status !== "active") throw new DraftError("DRAFT_COMPLETE", `Draft ${draftId} is complete`);
    const pl = tx.select({ id: players.id }).from(players).where(eq(players.id, playerId)).get();
    if (!pl) throw new DraftError("PLAYER_NOT_FOUND", `Player ${playerId} not found`);
    const dup = tx
      .select({ pick: draftPicks.pick })
      .from(draftPicks)
      .where(and(eq(draftPicks.draftId, draftId), eq(draftPicks.playerId, playerId)))
      .get();
    if (dup) throw new DraftError("PLAYER_ALREADY_DRAFTED", `Player ${playerId} was already drafted at pick ${dup.pick}`);

    const { round, teamSlot } = snakePosition(d.currentPick, d.teams);
    tx.insert(draftPicks)
      .values({ draftId, pick: d.currentPick, round, teamSlot, playerId, source, timestamp: new Date().toISOString() })
      .run();
    const next = d.currentPick + 1;
    tx.update(drafts)
      .set({ currentPick: next, status: next > d.teams * d.rounds ? "complete" : "active" })
      .where(eq(drafts.id, draftId))
      .run();
    return loadDraft(tx as unknown as Db, draftId)!;
  });
}

export function undoLastPick(db: Db, draftId: number): DraftState {
  return db.transaction((tx) => {
    const d = tx.select().from(drafts).where(eq(drafts.id, draftId)).get();
    if (!d) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
    const last = tx.select().from(draftPicks).where(eq(draftPicks.draftId, draftId)).orderBy(desc(draftPicks.pick)).limit(1).get();
    if (!last) throw new DraftError("NO_PICKS_TO_UNDO", "No picks to undo");
    tx.delete(draftPicks).where(eq(draftPicks.id, last.id)).run();
    tx.update(drafts).set({ currentPick: last.pick, status: "active" }).where(eq(drafts.id, draftId)).run();
    return loadDraft(tx as unknown as Db, draftId)!;
  });
}

/** Undoes picks until `toPick` is the pick on the clock again (removes every pick >= toPick). */
export function undoToPick(db: Db, draftId: number, toPick: number): DraftState {
  return db.transaction((tx) => {
    const d = tx.select().from(drafts).where(eq(drafts.id, draftId)).get();
    if (!d) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
    const count = tx.select({ pick: draftPicks.pick }).from(draftPicks).where(eq(draftPicks.draftId, draftId)).all().length;
    if (count === 0) throw new DraftError("NO_PICKS_TO_UNDO", "No picks to undo");
    if (!Number.isInteger(toPick) || toPick < 1 || toPick > count)
      throw new DraftError("INVALID_CONFIG", `toPick must be between 1 and ${count}`);
    tx.delete(draftPicks).where(and(eq(draftPicks.draftId, draftId), gte(draftPicks.pick, toPick))).run();
    tx.update(drafts).set({ currentPick: toPick, status: "active" }).where(eq(drafts.id, draftId)).run();
    return loadDraft(tx as unknown as Db, draftId)!;
  });
}

export interface AutopickOptions {
  /** Stop when it is the user's pick (always true: bots never pick the user's slot). Default true. */
  untilUserTurn?: boolean;
  /** Max number of bot picks. Default: unlimited when untilUserTurn, else 1. */
  count?: number;
  seed?: number;
}

/**
 * Runs opponent picks (source "simulation") one per transaction until the user's slot is on
 * the clock, the draft completes, the player pool is exhausted, or `count` picks were made.
 */
export function autopick(db: Db, draftId: number, opts: AutopickOptions = {}, records?: PlayerRecord[]): DraftState {
  let state = loadDraft(db, draftId);
  if (!state) throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
  if (state.status !== "active") throw new DraftError("DRAFT_COMPLETE", `Draft ${draftId} is complete`);
  const untilUser = opts.untilUserTurn ?? true;
  const limit = opts.count ?? (untilUser ? Infinity : 1);
  const recs = records ?? getAllPlayerRecords(db);
  const { valuations } = computeValuations(recs);
  const byId = new Map(recs.map((r) => [r.player.id, r]));
  const taken = new Set(state.picks.map((p) => p.playerId));
  const rosters = new Map<number, Position[][]>();
  for (const p of state.picks) {
    const pos = byId.get(p.playerId)?.player.positions;
    if (pos) rosters.set(p.teamSlot, [...(rosters.get(p.teamSlot) ?? []), pos]);
  }
  const seed = opts.seed ?? (Math.imul(draftId + 1, 2654435761) ^ Math.imul(state.currentPick + 13, 40503)) >>> 0;
  const rng = createRng(seed);
  const model = activeOpponentModel(db);
  const pool = recs.map((r) => ({
    id: r.player.id,
    adp: r.market.yahooAdp,
    adpStdDev: r.market.adpStdDev,
    value: valuations[r.player.id]?.nineCat ?? 0,
    positions: r.player.positions,
  }));

  let made = 0;
  while (state.status === "active" && made < limit) {
    const { teamSlot } = snakePosition(state.currentPick, state.teams);
    if (teamSlot === state.userSlot) break;
    const id = pickForOpponent(
      pool.filter((p) => !taken.has(p.id)),
      rng,
      { teamRosterPositions: rosters.get(teamSlot) ?? [], model },
    );
    if (id === null) break;
    state = recordPick(db, draftId, id, "simulation");
    taken.add(id);
    rosters.set(teamSlot, [...(rosters.get(teamSlot) ?? []), byId.get(id)!.player.positions]);
    made++;
  }
  return state;
}

/** Removes all picks, keeping the draft config. */
export function resetDraft(db: Db, draftId: number): DraftState {
  return db.transaction((tx) => {
    if (!tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, draftId)).get())
      throw new DraftError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
    tx.delete(draftPicks).where(eq(draftPicks.draftId, draftId)).run();
    tx.update(drafts).set({ currentPick: 1, status: "active" }).where(eq(drafts.id, draftId)).run();
    return loadDraft(tx as unknown as Db, draftId)!;
  });
}

/** Deletes the draft and its picks. Returns false if it did not exist. */
export function deleteDraft(db: Db, draftId: number): boolean {
  return db.delete(drafts).where(eq(drafts.id, draftId)).returning({ id: drafts.id }).all().length > 0;
}
