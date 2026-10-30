import fs from "node:fs";
import path from "node:path";
import { parseScheduleJson, type ScheduleData } from "@/engine/season/schedule";
import { fetchTextWithRetry } from "../projections/fetch-cache";

/** NBA.com's static league schedule (every team's games). cdn.nba.com is behind a CDN that sometimes answers 403 to non-browser clients. */
export const SCHEDULE_URL = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json";
export const SCHEDULE_CACHE_FILE = "nba-schedule.json";
export const SCHEDULE_MAX_AGE_MS = 24 * 3_600_000;

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface ScheduleStatus {
  /** ISO time of the cache file (when it was last fetched), null when there is none. */
  fetchedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  games: number;
  firstDate: string | null;
  lastDate: string | null;
  error?: string;
}

const g = globalThis as unknown as { __scheduleParsed?: { key: string; data: ScheduleData }; __scheduleRefresh?: Promise<ScheduleStatus>; __scheduleError?: string };
const file = (dir: string) => path.join(dir, SCHEDULE_CACHE_FILE);

/** The cached schedule (parsed once per file version); null when there is no usable cache. */
export function loadSchedule(cacheDir: string): ScheduleData | null {
  try {
    const f = file(cacheDir);
    const st = fs.statSync(f);
    const key = `${f}:${st.mtimeMs}:${st.size}`;
    if (g.__scheduleParsed?.key === key) return g.__scheduleParsed.data;
    const data = parseScheduleJson(JSON.parse(fs.readFileSync(f, "utf8")));
    g.__scheduleParsed = { key, data };
    return data;
  } catch {
    return null;
  }
}

export function scheduleStatus(cacheDir: string, now = Date.now()): ScheduleStatus {
  const data = loadSchedule(cacheDir);
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(file(cacheDir)).mtimeMs;
  } catch {
    /* no cache */
  }
  const ageMs = mtime === null ? null : Math.max(0, now - mtime);
  return {
    fetchedAt: mtime === null ? null : new Date(mtime).toISOString(),
    ageMs,
    stale: ageMs === null || ageMs > SCHEDULE_MAX_AGE_MS,
    games: data?.games ?? 0,
    firstDate: data?.firstDate ?? null,
    lastDate: data?.lastDate ?? null,
    ...(g.__scheduleError ? { error: g.__scheduleError } : {}),
  };
}

/** Validates and stores a schedule document (used by the fetch and by `pnpm season:schedule --file`). Throws on an unusable document. */
export function storeSchedule(cacheDir: string, text: string): ScheduleData {
  const data = parseScheduleJson(JSON.parse(text));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file(cacheDir), text);
  g.__scheduleError = undefined;
  return data;
}

/**
 * Refreshes the cache when it is missing or older than 24 h (or `force`). Single flight; never throws: a failure keeps the old cache and is
 * reported in the status (`error`). Without any cache the engines assume 3.5 games per week.
 */
export function refreshSchedule(cacheDir: string, opts: { force?: boolean; fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<ScheduleStatus> {
  const st = scheduleStatus(cacheDir);
  if (!opts.force && !st.stale && st.games > 0) return Promise.resolve(st);
  if (g.__scheduleRefresh) return g.__scheduleRefresh;
  g.__scheduleRefresh = fetchTextWithRetry(SCHEDULE_URL, HEADERS, { retries: 2, timeoutMs: 20_000, log: opts.log, fetchImpl: opts.fetchImpl })
    .then((text) => {
      storeSchedule(cacheDir, text);
      return scheduleStatus(cacheDir);
    })
    .catch((e) => {
      g.__scheduleError = `schedule fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      return scheduleStatus(cacheDir);
    })
    .finally(() => {
      g.__scheduleRefresh = undefined;
    });
  return g.__scheduleRefresh;
}

export function resetScheduleCaches(): void {
  g.__scheduleParsed = undefined;
  g.__scheduleError = undefined;
}
