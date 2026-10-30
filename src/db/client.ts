import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/** Opens a database, applies pragmas and migrations. Use ":memory:" in tests. */
export function createDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

const g = globalThis as unknown as { __fantasyDb?: Db; __fantasyMigrationsKey?: string };

/** Changes whenever a migration is added (the journal lists every migration). */
function migrationsKey(): string {
  try {
    return fs.statSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json")).mtimeMs.toString();
  } catch {
    return "";
  }
}

/**
 * Cached connection (survives Next dev HMR). If a migration was added while the server was running, it is applied on
 * the next request instead of failing with "no such table" until a restart.
 */
export function getDb(): Db {
  const key = migrationsKey();
  if (!g.__fantasyDb) {
    g.__fantasyDb = createDb(process.env.DB_FILE_NAME ?? "./data/fantasy.sqlite");
    g.__fantasyMigrationsKey = key;
  } else if (key !== g.__fantasyMigrationsKey) {
    migrate(g.__fantasyDb, { migrationsFolder: MIGRATIONS_FOLDER });
    g.__fantasyMigrationsKey = key;
  }
  return g.__fantasyDb;
}
