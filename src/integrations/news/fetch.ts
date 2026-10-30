import fs from "node:fs";
import path from "node:path";
import { fetchTextWithRetry } from "../projections/fetch-cache";
import type { NewsProvider } from "./types";

export const NEWS_CACHE_DIR = path.resolve(process.cwd(), "data", "cache", "news");

export interface ProviderFetchOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Total attempts (1 + retries). Default 3 = 2 retries. */
  attempts?: number;
  log?: (m: string) => void;
}

/** Browser-UA GET (20 s timeout, 2 retries); writes data/cache/news/<id>.<ext> + <id>.meta.json (timestamp). Throws on failure. */
export async function fetchProvider(p: NewsProvider, o: ProviderFetchOptions = {}): Promise<{ text: string; fetchedAt: string }> {
  const text = await fetchTextWithRetry(p.url, p.headers ?? {}, { timeoutMs: o.timeoutMs ?? 20_000, retries: o.attempts ?? 3, fetchImpl: o.fetchImpl, log: o.log });
  if (!text.trim()) throw new Error("empty response");
  const fetchedAt = new Date().toISOString();
  try {
    const dir = o.cacheDir ?? NEWS_CACHE_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(/*turbopackIgnore: true*/ dir, `${p.id}.${p.ext}`), text);
    fs.writeFileSync(path.join(/*turbopackIgnore: true*/ dir, `${p.id}.meta.json`), JSON.stringify({ url: p.url, fetchedAt, bytes: text.length }));
  } catch {
    // cache is best effort
  }
  return { text, fetchedAt };
}
