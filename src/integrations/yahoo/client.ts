import { YAHOO_API_BASE } from "./config";
import { YahooError } from "./errors";
import { getAccessToken, refreshIfNeeded } from "./oauth";

export type YahooGet = (path: string) => Promise<unknown>;

export interface ClientDeps {
  fetchFn?: typeof fetch;
  getToken?: () => Promise<string>;
  /** Forces a token refresh and returns the new access token. */
  refreshToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildUrl(base: string, p: string): string {
  const clean = p.replace(/^\/+/, "");
  return `${base}/${clean}${clean.includes("?") ? "&" : "?"}format=json`;
}

/** Builds a `yahooGet(path)` function. Matrix params (";start=0;count=25") stay in the path. */
export function createYahooGet(deps: ClientDeps = {}): YahooGet {
  const fetchFn = deps.fetchFn ?? fetch;
  const getToken = deps.getToken ?? getAccessToken;
  const refreshToken = deps.refreshToken ?? (async () => (await refreshIfNeeded({ force: true })).access_token);
  const sleep = deps.sleep ?? defaultSleep;
  const base = deps.baseUrl ?? YAHOO_API_BASE;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxRetries = deps.maxRetries ?? 3;
  const backoff = deps.backoffMs ?? 500;

  return async function yahooGet(p: string): Promise<unknown> {
    const url = buildUrl(base, p);
    let token = await getToken();
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(backoff * 2 ** attempt++);
          continue;
        }
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        throw new YahooError("NETWORK", timedOut ? `Yahoo request timed out after ${timeoutMs}ms` : `Yahoo request failed: ${(e as Error).message}`);
      }

      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          token = await refreshToken();
          continue;
        }
        throw new YahooError("AUTH", "Yahoo rejected the access token even after refresh. Run `pnpm yahoo:auth` again.", 401);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          const ra = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : backoff * 2 ** attempt);
          attempt++;
          continue;
        }
        throw res.status === 429
          ? new YahooError("RATE_LIMIT", "Yahoo rate limit hit (429); retries exhausted", 429)
          : new YahooError("NETWORK", `Yahoo server error ${res.status}; retries exhausted`, res.status);
      }
      // Yahoo answers 400 for unknown/invalid resources, so 400 is treated like 404.
      if (res.status === 404 || res.status === 400) throw new YahooError("NOT_FOUND", `Yahoo resource not found or invalid request (${res.status}): ${p}`, res.status);
      if (res.status === 403) throw new YahooError("AUTH", "Yahoo denied access (403). The app may lack Fantasy Sports read permission.", 403);
      if (!res.ok) throw new YahooError("NETWORK", `Unexpected Yahoo response ${res.status}`, res.status);

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new YahooError("PARSE", `Yahoo returned a non-JSON body for ${p}`);
      }
      const err = (json as { error?: { description?: string } } | null)?.error;
      if (err) {
        const d = String(err.description ?? "unknown error");
        throw new YahooError(/token|auth|login/i.test(d) ? "AUTH" : "NOT_FOUND", `Yahoo error: ${d}`);
      }
      return json;
    }
  };
}

let shared: YahooGet | null = null;
/** Default client against the live API. */
export function yahooGet(path: string): Promise<unknown> {
  shared ??= createYahooGet();
  return shared(path);
}
