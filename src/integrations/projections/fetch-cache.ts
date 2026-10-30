import fs from "node:fs";
import path from "node:path";

export interface FetchOptions {
  cacheDir: string;
  /** Refetch even when a cache file exists. */
  refresh?: boolean;
  /** Never touch the network: cache only. */
  offline?: boolean;
  timeoutMs?: number;
  retries?: number;
  log?: (m: string) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with timeout + retries. Throws the last error. */
export async function fetchTextWithRetry(url: string, headers: Record<string, string>, o: Pick<FetchOptions, "timeoutMs" | "retries" | "log" | "fetchImpl">): Promise<string> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const retries = o.retries ?? 3;
  const f = o.fetchImpl ?? fetch;
  let last: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(url, { headers, signal: ac.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = ac.signal.aborted ? new Error(`timeout after ${timeoutMs}ms`) : e;
      o.log?.(`  attempt ${attempt}/${retries} failed for ${new URL(url).host}${new URL(url).pathname}: ${(last as Error).message}`);
      if (attempt < retries) await sleep(Math.min(5000, 500 * attempt * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Cache-first text fetch: returns data/cache/<name> unless `refresh`; otherwise fetches and writes the cache.
 * `validate` runs on fresh responses before they are cached (so an HTML block page is never cached as JSON).
 */
export async function cachedText(name: string, url: string, headers: Record<string, string>, o: FetchOptions, validate?: (text: string) => void): Promise<{ text: string; fromCache: boolean }> {
  const file = path.join(o.cacheDir, name);
  if (!o.refresh && fs.existsSync(file)) return { text: fs.readFileSync(file, "utf8"), fromCache: true };
  if (o.offline) throw new Error(`offline mode and no cache file ${file}`);
  const text = await fetchTextWithRetry(url, headers, o);
  validate?.(text);
  fs.mkdirSync(o.cacheDir, { recursive: true });
  fs.writeFileSync(file, text);
  return { text, fromCache: false };
}
