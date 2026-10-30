import { inArray } from "drizzle-orm";
import path from "node:path";
import { getDb, type Db } from "./client";
import { draftPicks, playerMarket, playerNews, playerProjections, playerRisk, playerStatusUpdates, players } from "./schema";
import { loadPlayerRecordsFromCsv } from "../integrations/projections/csv";
import type { PlayerRecord } from "../types";

/** Upserts all records into the four player tables in a single transaction. */
export function seedFromRecords(db: Db, records: PlayerRecord[]): number {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const { player, projection: p, market: m, risk: r } of records) {
      const pl = {
        yahooPlayerKey: player.yahooPlayerKey,
        name: player.name,
        nbaTeam: player.nbaTeam,
        positions: player.positions.join("/"),
        age: player.age,
      };
      tx.insert(players).values({ id: player.id, ...pl }).onConflictDoUpdate({ target: players.id, set: pl }).run();
      const { playerId: _a, ...pj } = p;
      tx.insert(playerProjections).values(p).onConflictDoUpdate({ target: playerProjections.playerId, set: pj }).run();
      const mk = { yahooAdp: m.yahooAdp, adpStdDev: m.adpStdDev, rank: m.rank, timestamp: now };
      tx.insert(playerMarket).values({ playerId: m.playerId, ...mk }).onConflictDoUpdate({ target: playerMarket.playerId, set: mk }).run();
      const { playerId: _b, ...rk } = r;
      tx.insert(playerRisk).values(r).onConflictDoUpdate({ target: playerRisk.playerId, set: rk }).run();
    }
  });
  return records.length;
}

export interface ReplaceReport {
  /** Players removed (not in the CSVs, never drafted). */
  deleted: { id: string; name: string }[];
  /** Players missing from the CSVs but kept because a draft pick references them. */
  keptDrafted: { id: string; name: string }[];
}

/**
 * Removes players that are not in `keepIds` (together with their projection/market/risk rows), except players
 * referenced by any draft_picks row — those are kept so existing drafts stay intact. Runs in one transaction.
 */
export function removeStalePlayers(db: Db, keepIds: Iterable<string>): ReplaceReport {
  const keep = new Set(keepIds);
  return db.transaction((tx) => {
    const referenced = new Set(tx.selectDistinct({ id: draftPicks.playerId }).from(draftPicks).all().map((r) => r.id));
    const report: ReplaceReport = { deleted: [], keptDrafted: [] };
    const doomed: string[] = [];
    for (const p of tx.select({ id: players.id, name: players.name }).from(players).all()) {
      if (keep.has(p.id)) continue;
      if (referenced.has(p.id)) report.keptDrafted.push(p);
      else {
        report.deleted.push(p);
        doomed.push(p.id);
      }
    }
    // Chunked to stay under SQLite's bound-parameter limit; dependent rows are deleted explicitly (no reliance on FK cascade).
    for (let i = 0; i < doomed.length; i += 200) {
      const chunk = doomed.slice(i, i + 200);
      tx.delete(playerProjections).where(inArray(playerProjections.playerId, chunk)).run();
      tx.delete(playerMarket).where(inArray(playerMarket.playerId, chunk)).run();
      tx.delete(playerRisk).where(inArray(playerRisk.playerId, chunk)).run();
      tx.delete(playerStatusUpdates).where(inArray(playerStatusUpdates.playerId, chunk)).run();
      tx.delete(playerNews).where(inArray(playerNews.playerId, chunk)).run();
      tx.delete(players).where(inArray(players.id, chunk)).run();
    }
    return report;
  });
}

// Only run when executed directly (pnpm db:seed [--replace]).
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (/[\\/]seed\.ts$/.test(entry)) {
  const dir = path.resolve(process.cwd(), "data");
  const replace = process.argv.includes("--replace");
  const records = loadPlayerRecordsFromCsv(dir);
  const db = getDb();
  const n = seedFromRecords(db, records);
  console.log(`Seeded ${n} players from ${dir}`);
  if (replace) {
    const r = removeStalePlayers(db, records.map((x) => x.player.id));
    console.log(`--replace: deleted ${r.deleted.length} player(s) not in the CSVs${r.deleted.length ? ` (${r.deleted.slice(0, 10).map((p) => p.name).join(", ")}${r.deleted.length > 10 ? ", …" : ""})` : ""}`);
    if (r.keptDrafted.length) console.log(`--replace: kept ${r.keptDrafted.length} player(s) not in the CSVs because they are referenced by draft picks: ${r.keptDrafted.map((p) => `${p.name} [${p.id}]`).join(", ")}`);
    const total = db.select({ id: players.id }).from(players).all().length;
    console.log(`players table now has ${total} rows`);
  }
}
