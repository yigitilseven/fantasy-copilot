import crypto from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { getAllPlayerRecords, loadNewsOverlay } from "../../db/repository";
import { newsSourceStatus, playerNews, playerStatusUpdates, players } from "../../db/schema";
import type { InjuryStatus } from "../../types";
import { fetchProvider, type ProviderFetchOptions } from "./fetch";
import { buildNameMatcher, matchNewsItem } from "./match";
import { mergeByPlayer } from "./merge";
import { PROVIDERS } from "./providers";
import type { NewsItem, NewsProvider, StatusReport } from "./types";

export const NEWS_MAX_AGE_MS = 6 * 3_600_000;
/** Before a new draft starts, news older than this is refreshed in the background (see kickPredraftNewsRefresh). */
export const NEWS_PREDRAFT_MAX_AGE_MS = 60 * 60_000;
/** After a failed run, wait this long before another automatic attempt. */
export const NEWS_RETRY_AFTER_MS = 30 * 60_000;
const NEWS_KEEP_DAYS = 30;
/** An injury source returning fewer rows than this is treated as broken (never used to "clear" players). */
const MIN_INJURY_ROWS = 5;

export interface SourceResult { id: string; label: string; kind: "injuries" | "news"; ok: boolean; error?: string; items: number }
export interface StatusChange {
  playerId: string; name: string; adp: number;
  before: { status: InjuryStatus; estReturn?: string };
  after: { status: InjuryStatus; estReturn?: string; injury?: string; source?: string };
}
export interface UpdateSummary {
  startedAt: string; finishedAt: string;
  sources: SourceResult[];
  /** Players whose effective status/return changed (before -> after). */
  statusChanges: StatusChange[];
  statusRowsInserted: number;
  cleared: number;
  /** Injury rows whose player is not in our DB (ignored). */
  unmatchedInjuryRows: number;
  newsInserted: number;
  newsPlayers: number;
}

export interface UpdateOptions extends ProviderFetchOptions {
  providers?: NewsProvider[];
  now?: Date;
}

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);

function recordSource(db: Db, p: NewsProvider, ok: boolean, items: number, error: string | undefined, at: string) {
  const prev = db.select().from(newsSourceStatus).where(eq(newsSourceStatus.source, p.id)).get();
  const row = {
    kind: p.kind,
    lastAttemptAt: at,
    lastSuccessAt: ok ? at : (prev?.lastSuccessAt ?? null),
    lastError: ok ? null : (error ?? "failed").slice(0, 300),
    itemCount: ok ? items : (prev?.itemCount ?? 0),
  };
  db.insert(newsSourceStatus).values({ source: p.id, ...row }).onConflictDoUpdate({ target: newsSourceStatus.source, set: row }).run();
}

/**
 * Fetches every provider (a failing one is recorded and skipped; last good data stays in the DB), merges injury reports
 * by recency, appends status updates only when something changed, marks players that vanished from all successful
 * injury reports as healthy ("cleared"), and attaches deduplicated headlines to the players they name.
 */
export async function runNewsUpdate(db: Db, opts: UpdateOptions = {}): Promise<UpdateSummary> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const providers = opts.providers ?? PROVIDERS;

  const fetched = await Promise.all(
    providers.map(async (p) => {
      try {
        const { text } = await fetchProvider(p, opts);
        const res = p.parse(text, now);
        if (p.kind === "injuries" && res.reports.length < MIN_INJURY_ROWS) throw new Error(`only ${res.reports.length} injury rows parsed (layout change?)`);
        if (p.kind === "news" && res.news.length === 0) throw new Error("no news items parsed");
        return { p, res, error: undefined as string | undefined };
      } catch (e) {
        return { p, res: null, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const sources: SourceResult[] = [];
  for (const f of fetched) {
    const items = f.res ? (f.p.kind === "injuries" ? f.res.reports.length : f.res.news.length) : 0;
    recordSource(db, f.p, !!f.res, items, f.error, nowIso);
    sources.push({ id: f.p.id, label: f.p.label, kind: f.p.kind, ok: !!f.res, error: f.error, items });
  }
  const okFetched = fetched.filter((f) => f.res);

  const dbPlayers = db.select({ id: players.id, name: players.name }).from(players).all();
  const nameById = new Map(dbPlayers.map((p) => [p.id, p.name]));
  const matcher = buildNameMatcher(dbPlayers);
  const before = new Map(getAllPlayerRecords(db, now.getTime()).map((r) => [r.player.id, r]));
  const latestStored = loadNewsOverlay(db).status;

  // ---- injuries
  const okInjury = okFetched.filter((f) => f.p.kind === "injuries");
  const allReports: StatusReport[] = okInjury.flatMap((f) => f.res!.reports);
  let unmatched = 0;
  const merged = mergeByPlayer(allReports, (r) => {
    const id = matcher.byName(r.name);
    if (!id) unmatched++;
    return id;
  });
  let inserted = 0;
  let cleared = 0;
  db.transaction((tx) => {
    const latestRows = new Map(
      tx.select({ id: sql<number>`max(${playerStatusUpdates.id})`, playerId: playerStatusUpdates.playerId }).from(playerStatusUpdates).groupBy(playerStatusUpdates.playerId).all().map((r) => [r.playerId, r.id]),
    );
    for (const [id, r] of merged) {
      const prev = latestStored.get(id);
      if (prev && prev.status === r.status && (prev.estReturnDate ?? null) === r.estReturn) {
        tx.update(playerStatusUpdates).set({ fetchedAt: nowIso }).where(eq(playerStatusUpdates.id, latestRows.get(id)!)).run();
        continue;
      }
      tx.insert(playerStatusUpdates).values({ playerId: id, status: r.status, injury: r.injury, estReturnDate: r.estReturn, comment: r.comment, source: r.source, reportedAt: r.reportedAt ?? nowIso, fetchedAt: nowIso }).run();
      inserted++;
    }
    if (okInjury.length > 0) {
      const okLabels = new Set(okInjury.map((f) => f.p.label));
      for (const p of dbPlayers) {
        if (merged.has(p.id)) continue;
        const eff = before.get(p.id)?.risk.currentStatus ?? "healthy";
        const prev = latestStored.get(p.id);
        if (prev?.status === "healthy") continue;
        if (eff === "healthy" && !prev) continue;
        // Only clear what the sources that answered today could have reported (avoids clearing on partial outages).
        if (prev && prev.source !== "cleared" && !okLabels.has(prev.source)) continue;
        tx.insert(playerStatusUpdates).values({ playerId: p.id, status: "healthy", injury: null, estReturnDate: null, comment: null, source: "cleared", reportedAt: nowIso, fetchedAt: nowIso }).run();
        inserted++;
        cleared++;
      }
    }
  });

  // ---- news
  const items: NewsItem[] = okFetched.flatMap((f) => f.res!.news);
  const cutoff = now.getTime() - NEWS_KEEP_DAYS * 86_400_000;
  let newsInserted = 0;
  const newsPlayers = new Set<string>();
  db.transaction((tx) => {
    for (const it of items) {
      if (Date.parse(it.publishedAt) < cutoff) continue;
      for (const pid of matchNewsItem(matcher, it)) {
        const res = tx
          .insert(playerNews)
          .values({ id: hash(`${pid}|${it.link}|${it.title}`), playerId: pid, title: it.title, link: it.link, source: it.source, publishedAt: it.publishedAt, fetchedAt: nowIso })
          .onConflictDoNothing()
          .run();
        newsPlayers.add(pid);
        newsInserted += res.changes;
      }
    }
    tx.delete(playerNews).where(and(lt(playerNews.publishedAt, new Date(cutoff).toISOString()))).run();
  });

  // ---- diff
  const after = getAllPlayerRecords(db, now.getTime());
  const statusChanges: StatusChange[] = [];
  for (const r of after) {
    const b = before.get(r.player.id);
    if (!b) continue;
    if (b.risk.currentStatus !== r.risk.currentStatus || b.risk.estReturn !== r.risk.estReturn)
      statusChanges.push({
        playerId: r.player.id, name: nameById.get(r.player.id) ?? r.player.name, adp: r.market.yahooAdp,
        before: { status: b.risk.currentStatus, estReturn: b.risk.estReturn },
        after: { status: r.risk.currentStatus, estReturn: r.risk.estReturn, injury: r.risk.injuryNote, source: r.risk.statusSource },
      });
  }
  statusChanges.sort((a, b) => a.adp - b.adp);
  return { startedAt: nowIso, finishedAt: new Date().toISOString(), sources, statusChanges, statusRowsInserted: inserted, cleared, unmatchedInjuryRows: unmatched, newsInserted, newsPlayers: newsPlayers.size };
}

// ---------------------------------------------------------------- status for the UI / auto refresh

export interface NewsStatus {
  lastAttemptAt: string | null;
  /** Most recent time at least one source succeeded. */
  lastSuccessAt: string | null;
  sources: { id: string; kind: string; lastAttemptAt: string; lastSuccessAt: string | null; lastError: string | null; items: number; ok: boolean }[];
}

export function getNewsStatus(db: Db): NewsStatus {
  let rows: (typeof newsSourceStatus.$inferSelect)[] = [];
  try {
    rows = db.select().from(newsSourceStatus).all();
  } catch {
    // table missing: never updated
  }
  const max = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    lastAttemptAt: max(rows.map((r) => r.lastAttemptAt)),
    lastSuccessAt: max(rows.map((r) => r.lastSuccessAt)),
    sources: rows.map((r) => ({ id: r.source, kind: r.kind, lastAttemptAt: r.lastAttemptAt, lastSuccessAt: r.lastSuccessAt, lastError: r.lastError, items: r.itemCount, ok: r.lastError == null })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Stale (> 6 h since the last success) and not attempted within the last 30 minutes. */
export function newsRefreshDue(status: NewsStatus, now: number = Date.now()): boolean {
  const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
  const attempt = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : 0;
  return now - last > NEWS_MAX_AGE_MS && now - attempt > NEWS_RETRY_AFTER_MS;
}

/** True when no source succeeded within `maxAgeMs` (never updated = stale). */
export function newsOlderThan(status: NewsStatus, maxAgeMs: number, now: number = Date.now()): boolean {
  const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
  return now - last > maxAgeMs;
}
