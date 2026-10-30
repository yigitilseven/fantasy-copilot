import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { getNewsStatus, NEWS_PREDRAFT_MAX_AGE_MS, newsOlderThan, newsRefreshDue, runNewsUpdate, type NewsStatus, type UpdateSummary } from "@/integrations/news/update";
import { defaultStatsCacheDir } from "@/integrations/projections/stats-lookup";
import { fetchFantasyProsProjections, fpCacheAgeMs, FP_PROJECTIONS_MAX_AGE_MS } from "@/integrations/projections/fantasypros-projections";
import { invalidateRecommendationCaches } from "./recommendations";
import { recordInjuryEvents } from "./injury-events";

const g = globalThis as unknown as { __newsRefresh?: Promise<UpdateSummary | null>; __newsLastSummary?: UpdateSummary; __fpRefresh?: Promise<void> };

/** Single-flight refresh: concurrent callers share one run. Never throws; on failure the DB keeps the last good data. */
export function refreshNews(db: Db = getDb()): Promise<UpdateSummary | null> {
  if (!g.__newsRefresh) {
    g.__newsRefresh = runNewsUpdate(db)
      .then((s) => {
        g.__newsLastSummary = s;
        invalidateRecommendationCaches();
        try {
          recordInjuryEvents(db, s); // queue roster injury changes for the alert job (no-op without a season league)
        } catch (e) {
          console.error("injury events failed:", e instanceof Error ? e.message : e);
        }
        return s;
      })
      .catch((e) => {
        console.error("news refresh failed:", e);
        return null;
      })
      .finally(() => {
        g.__newsRefresh = undefined;
      });
  }
  return g.__newsRefresh;
}

/**
 * Refreshes the cached FantasyPros projections (data/cache) in the background when the cache is missing or older than 12 h; a failure
 * keeps the old cache. Single-flight, never awaited by a request; same switches as the news refresh. Returns whether it was scheduled.
 */
export function kickFantasyProsRefresh(): boolean {
  if (process.env.NEWS_AUTO_REFRESH === "0") return false;
  if ((process.env.NODE_ENV === "test" || process.env.VITEST) && process.env.NEWS_PREDRAFT_REFRESH !== "1") return false;
  const dir = defaultStatsCacheDir();
  const age = fpCacheAgeMs(dir);
  if (g.__fpRefresh || (age !== null && age < FP_PROJECTIONS_MAX_AGE_MS)) return false;
  g.__fpRefresh = fetchFantasyProsProjections({ cacheDir: dir, refresh: true, retries: 2, timeoutMs: 20_000 })
    .then(() => invalidateRecommendationCaches())
    .catch((e) => console.error("FantasyPros projections refresh failed:", e instanceof Error ? e.message : e))
    .finally(() => {
      g.__fpRefresh = undefined;
    });
  return true;
}

export function isNewsRefreshing(): boolean {
  return !!g.__newsRefresh;
}

/**
 * Called from API routes: when the last successful update is older than 6 h, starts a background refresh (not awaited,
 * so never on a request's critical path). Disabled by NEWS_AUTO_REFRESH=0 and under tests.
 */
export function maybeKickNewsRefresh(db: Db = getDb()): void {
  if (process.env.NEWS_AUTO_REFRESH === "0" || process.env.NODE_ENV === "test" || process.env.VITEST) return;
  try {
    if (g.__newsRefresh || !newsRefreshDue(getNewsStatus(db))) return;
    setTimeout(() => void refreshNews(db), 0);
  } catch {
    // never break a request
  }
}

/**
 * Called when a new draft is created: when the last successful update is older than `maxAgeMs` (default 60 min), starts the
 * single-flight refresh in the background (never awaited, so the response is not delayed). Returns whether it was scheduled.
 * Disabled by NEWS_AUTO_REFRESH=0, and under tests unless NEWS_PREDRAFT_REFRESH=1.
 */
export function kickPredraftNewsRefresh(db: Db = getDb(), maxAgeMs: number = NEWS_PREDRAFT_MAX_AGE_MS): boolean {
  if (process.env.NEWS_AUTO_REFRESH === "0") return false;
  if ((process.env.NODE_ENV === "test" || process.env.VITEST) && process.env.NEWS_PREDRAFT_REFRESH !== "1") return false;
  try {
    // FantasyPros projections are opt-in (Yahoo only by default), so they are not refreshed before every draft.
    if (g.__newsRefresh || !newsOlderThan(getNewsStatus(db), maxAgeMs)) return false;
    setTimeout(() => void refreshNews(db), 0);
    return true;
  } catch {
    return false; // never break draft creation
  }
}

export interface NewsStatusResponse extends NewsStatus {
  refreshing: boolean;
  stale: boolean;
  lastSummary: Pick<UpdateSummary, "startedAt" | "statusRowsInserted" | "cleared" | "newsInserted" | "newsPlayers"> & { statusChanges: number } | null;
}

export function newsStatusResponse(db: Db = getDb(), now = Date.now()): NewsStatusResponse {
  const st = getNewsStatus(db);
  const s = g.__newsLastSummary;
  return {
    ...st,
    refreshing: isNewsRefreshing(),
    stale: !st.lastSuccessAt || now - Date.parse(st.lastSuccessAt) > 6 * 3_600_000,
    lastSummary: s ? { startedAt: s.startedAt, statusRowsInserted: s.statusRowsInserted, cleared: s.cleared, newsInserted: s.newsInserted, newsPlayers: s.newsPlayers, statusChanges: s.statusChanges.length } : null,
  };
}
