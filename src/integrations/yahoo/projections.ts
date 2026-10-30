import { count, eq, like, max, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { players, yahooProjections } from "../../db/schema";
import { seedFromRecords } from "../../db/seed";
import { YAHOO_PROJECTION_SEASON } from "../../db/repository";
import type { PlayerRecord, Position } from "../../types";
import { nameKey } from "../projections/names";
import { canonTeam, buildNameIndex, matchPlayer, placeholderId, yahooKeyFor, yidKey } from "./dom-ingest";

export { YAHOO_PROJECTION_SEASON };

/**
 * Ingestion of Yahoo's own 2026-27 projections, read off the draft room's Players tab by the userscript (read-only, no Yahoo API).
 * Rows are matched to local players (Yahoo id -> players.yahoo_player_key first, then name/team/position with an ADP tie-break),
 * unmatched players (rookies, ...) are created as real player rows so they show up on the board, and every row is stored in
 * yahoo_projections (a separate table: CSV reseeds never touch it). getAllPlayerRecords overlays it on the PlayerRecord.
 */

export interface YahooProjectionRowInput {
  yahooId: string;
  playerName: string;
  nbaTeam?: string;
  positions?: string;
  injuryTag?: string;
  xrank?: number | null;
  rank?: number | null;
  adp?: number | null;
  gp?: number | null;
  fgPct?: number | null;
  ftPct?: number | null;
  threePm?: number | null;
  pts?: number | null;
  reb?: number | null;
  ast?: number | null;
  stl?: number | null;
  blk?: number | null;
  tov?: number | null;
}

export interface YahooIngestSummary {
  received: number;
  /** Rows now linked to a local player (existing or created). */
  matched: number;
  /** Players created because no local row matched. */
  created: number;
  /** Rows left unlinked because several local players fit. */
  ambiguous: number;
  /** Players whose yahoo_player_key was set by this call. */
  keysSet: number;
  capturedAt: string;
}

const POS = new Set(["PG", "SG", "SF", "PF", "C"]);
const positionsOf = (s: string | undefined): Position[] => {
  const out: Position[] = [];
  for (const t of (s ?? "").toUpperCase().split(/[^A-Z]+/)) {
    const add = t === "G" ? ["PG", "SG"] : t === "F" ? ["SF", "PF"] : POS.has(t) ? [t] : [];
    for (const p of add) if (!out.includes(p as Position)) out.push(p as Position);
  }
  return out;
};
const overlaps = (a: string, b: string): boolean => {
  const x = new Set(positionsOf(a));
  return positionsOf(b).some((p) => x.has(p));
};
const n = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A name/initial match is only trusted when the full name agrees, or the team or a position does (guards "K. Murray" the rookie vs Keegan Murray). */
function plausible(local: { name: string; nbaTeam: string; positions: string }, row: YahooProjectionRowInput): boolean {
  if (nameKey(local.name) === nameKey(row.playerName)) return true;
  if (row.nbaTeam && canonTeam(local.nbaTeam) === canonTeam(row.nbaTeam)) return true;
  return !!row.positions && overlaps(local.positions, row.positions);
}

function newPlayerRecord(id: string, row: YahooProjectionRowInput): PlayerRecord {
  const rank = n(row.rank);
  const adp = n(row.adp) && row.adp! > 0 ? row.adp! : 300 + (rank && rank > 0 ? rank : 100);
  const gp = n(row.gp) ?? 0;
  const positions = positionsOf(row.positions);
  return {
    player: { id, yahooPlayerKey: yahooKeyFor(row.yahooId), name: row.playerName, nbaTeam: canonTeam(row.nbaTeam) || "FA", positions: positions.length ? positions : ["SF"], age: 25 },
    // Zeros: the Yahoo overlay supplies the real per-game line (getAllPlayerRecords).
    projection: { playerId: id, games: gp, minutes: 0, pts: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, threePm: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 },
    market: { playerId: id, yahooAdp: adp, adpStdDev: Math.min(22, 0.8 + 0.12 * adp), rank: Math.max(1, Math.round(adp)) },
    risk: { playerId: id, projectedGames: gp, currentStatus: "healthy", injuryHistoryScore: 0.1, restRisk: 0.1, availabilityScore: Math.min(1, gp / 82), majorInjuryHistory: false, updatedAt: new Date().toISOString() },
  };
}

export function ingestYahooProjections(db: Db, rows: YahooProjectionRowInput[], opts: { season?: string; now?: string } = {}): YahooIngestSummary {
  const season = opts.season ?? YAHOO_PROJECTION_SEASON;
  const capturedAt = opts.now ?? new Date().toISOString();
  const summary: YahooIngestSummary = { received: 0, matched: 0, created: 0, ambiguous: 0, keysSet: 0, capturedAt };

  const byId = new Map<string, YahooProjectionRowInput>();
  for (const r of rows) byId.set(r.yahooId, r);
  summary.received = byId.size;

  db.transaction((tx) => {
    const t = tx as unknown as Db;
    const index = buildNameIndex(t);
    const claimed = new Set<string>(); // local ids already linked to a Yahoo id in this call
    const keyOf = new Map(tx.select({ id: players.id, key: players.yahooPlayerKey }).from(players).all().map((p) => [p.id, p.key]));

    for (const row of byId.values()) {
      const want = yahooKeyFor(row.yahooId);
      let playerId: string | null = null;
      let ambiguous = false;

      const exact = index.get(yidKey(row.yahooId));
      if (exact?.length === 1) playerId = exact[0].id;
      else {
        const m = matchPlayer(index, row);
        if (m.ok) {
          const k = keyOf.get(m.player.id);
          // Skip candidates that already belong to another Yahoo id / were claimed in this call / look like someone else.
          if (!claimed.has(m.player.id) && (!k || k === want) && plausible(m.player, row)) playerId = m.player.id;
        } else if (m.reason === "ambiguous") ambiguous = true;
      }

      if (!playerId && !ambiguous) {
        // Unknown to us (rookie, new signing, ...): a real row on the board. Same id scheme as pick placeholders.
        const id = placeholderId(row.playerName, row.nbaTeam);
        const exists = tx.select({ id: players.id }).from(players).where(eq(players.id, id)).get();
        if (!exists) {
          seedFromRecords(t, [newPlayerRecord(id, row)]);
          summary.created++;
          keyOf.set(id, want);
        }
        playerId = id;
      }

      if (playerId) {
        claimed.add(playerId);
        summary.matched++;
        if (keyOf.get(playerId) == null) {
          tx.update(players).set({ yahooPlayerKey: want }).where(eq(players.id, playerId)).run();
          keyOf.set(playerId, want);
          summary.keysSet++;
        }
      } else summary.ambiguous++;

      const v = {
        yahooId: row.yahooId, playerId, name: row.playerName, nbaTeam: row.nbaTeam ? canonTeam(row.nbaTeam) : null, positions: row.positions ?? null,
        gp: n(row.gp), fgPct: n(row.fgPct), ftPct: n(row.ftPct), threePm: n(row.threePm), pts: n(row.pts), reb: n(row.reb), ast: n(row.ast),
        stl: n(row.stl), blk: n(row.blk), tov: n(row.tov), xrank: n(row.xrank), rank: n(row.rank), adp: n(row.adp), season, capturedAt,
      };
      tx.insert(yahooProjections).values(v).onConflictDoUpdate({ target: yahooProjections.yahooId, set: { ...v, yahooId: undefined } }).run();
    }
  });
  return summary;
}

export interface YahooProjectionStatus {
  /** Rows captured for the season. */
  count: number;
  /** Rows linked to a local player. */
  matched: number;
  /** Linked players that were created from Yahoo rows (id yahoo-...). */
  created: number;
  /** Rows complete enough to drive a projection (GP > 0 and all categories). */
  usable: number;
  season: string;
  capturedAt: string | null;
}

export function yahooProjectionStatus(db: Db, season: string = YAHOO_PROJECTION_SEASON): YahooProjectionStatus {
  const base = { season, capturedAt: null as string | null, count: 0, matched: 0, created: 0, usable: 0 };
  const y = yahooProjections;
  try {
    const c = db.select({ n: count(), at: max(y.capturedAt) }).from(y).where(eq(y.season, season)).get();
    const matched = db.select({ n: count() }).from(y).where(sql`${y.season} = ${season} and ${y.playerId} is not null`).get();
    const created = db.select({ n: count() }).from(y).where(sql`${y.season} = ${season} and ${like(y.playerId, "yahoo-%")}`).get();
    const usable = db
      .select({ n: count() })
      .from(y)
      .where(sql`${y.season} = ${season} and ${y.gp} > 0 and ${y.fgPct} is not null and ${y.ftPct} is not null and ${y.pts} is not null and ${y.reb} is not null and ${y.ast} is not null and ${y.stl} is not null and ${y.blk} is not null and ${y.tov} is not null and ${y.threePm} is not null`)
      .get();
    return { ...base, count: c?.n ?? 0, capturedAt: c?.at ?? null, matched: matched?.n ?? 0, created: created?.n ?? 0, usable: usable?.n ?? 0 };
  } catch {
    return base;
  }
}
