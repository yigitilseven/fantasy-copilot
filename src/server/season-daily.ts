import type { Db } from "@/db/client";
import { getLeague, getBrief } from "@/db/season";
import { getNewsStatus, newsRefreshDue } from "@/integrations/news/update";
import { defaultStatsCacheDir } from "@/integrations/projections/stats-lookup";
import { refreshSchedule, scheduleStatus, type ScheduleStatus } from "@/integrations/schedule/nba-schedule";
import { gameDayOf } from "@/engine/season/schedule";
import { refreshNews } from "./news";
import { getOrCreateBrief } from "./season-brief";

export interface DailyResult {
  schedule: ScheduleStatus;
  newsRefreshed: boolean;
  briefCreated: boolean;
  day: string | null;
}

const g = globalThis as unknown as { __seasonDaily?: Promise<DailyResult>; __seasonTimer?: ReturnType<typeof setInterval> };

const disabled = () => process.env.SEASON_AUTO_REFRESH === "0" || process.env.NODE_ENV === "test" || !!process.env.VITEST;

/**
 * Once-a-day upkeep, safe to call often (single flight, each step only runs when due): refresh the NBA schedule cache (24 h), the injury/news
 * ingestion (6 h, the existing updater) and store today's brief if there is none yet. A failing step never throws; last good data stays.
 * `force` ignores the test/env switches (CLI use).
 */
export function runDailyRefresh(db: Db, opts: { force?: boolean; cacheDir?: string; now?: number } = {}): Promise<DailyResult> {
  if (g.__seasonDaily) return g.__seasonDaily;
  const cacheDir = opts.cacheDir ?? defaultStatsCacheDir();
  if (!opts.force && disabled()) return Promise.resolve({ schedule: scheduleStatus(cacheDir), newsRefreshed: false, briefCreated: false, day: null });
  g.__seasonDaily = (async () => {
    const schedule = await refreshSchedule(cacheDir);
    let newsRefreshed = false;
    try {
      if (newsRefreshDue(getNewsStatus(db), opts.now)) {
        await refreshNews(db);
        newsRefreshed = true;
      }
    } catch (e) {
      console.error("season: news refresh failed:", e instanceof Error ? e.message : e);
    }
    let briefCreated = false;
    let day: string | null = null;
    try {
      const lg = getLeague(db);
      if (lg) {
        day = gameDayOf(opts.now ?? Date.now(), lg.settings.timezone);
        if (!getBrief(db, lg.id, day)) briefCreated = !!getOrCreateBrief(db, { cacheDir, now: opts.now })?.created;
      }
    } catch (e) {
      console.error("season: brief failed:", e instanceof Error ? e.message : e);
    }
    return { schedule, newsRefreshed, briefCreated, day };
  })().finally(() => {
    g.__seasonDaily = undefined;
  });
  return g.__seasonDaily;
}

/** Fire-and-forget version for request handlers. */
export function kickDailyRefresh(db: Db): void {
  if (disabled() || g.__seasonDaily) return;
  setTimeout(() => void runDailyRefresh(db), 0);
}

/** Started once from instrumentation.ts: runs the upkeep shortly after boot and then every 30 minutes while the app runs. */
export function startSeasonScheduler(getDb: () => Db): void {
  if (disabled() || g.__seasonTimer) return;
  const tick = () => {
    try {
      void runDailyRefresh(getDb());
    } catch (e) {
      console.error("season scheduler:", e instanceof Error ? e.message : e);
    }
  };
  setTimeout(tick, 15_000);
  g.__seasonTimer = setInterval(tick, 30 * 60_000);
  g.__seasonTimer.unref?.();
}
