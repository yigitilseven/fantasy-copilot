import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { YAHOO_AUTH_URL, YAHOO_TOKEN_URL, getYahooConfig, tokenFilePath, type YahooConfig } from "./config";
import { YahooError } from "./errors";

export interface YahooTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

const tokenFile = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  expires_at: z.number(),
});

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().default(3600),
});

type FetchLike = typeof fetch;

export function loadTokens(file = tokenFilePath()): YahooTokens | null {
  if (!fs.existsSync(file)) return null;
  try {
    return tokenFile.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    throw new YahooError("AUTH", `Token file ${file} is unreadable or malformed; run \`pnpm yahoo:auth\` again.`);
  }
}

export function saveTokens(tokens: YahooTokens, file = tokenFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function buildAuthUrl(cfg: Pick<YahooConfig, "clientId" | "redirectUri">): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    language: "en-us",
  });
  return `${YAHOO_AUTH_URL}?${q.toString()}`;
}

async function postToken(body: Record<string, string>, cfg: YahooConfig, fetchFn: FetchLike, prev?: YahooTokens, now = Date.now()): Promise<YahooTokens> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  let res: Response;
  try {
    res = await fetchFn(YAHOO_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new YahooError("NETWORK", `Could not reach Yahoo token endpoint: ${(e as Error).message}`);
  }
  if (res.status === 429) throw new YahooError("RATE_LIMIT", "Yahoo token endpoint rate limited", 429);
  if (!res.ok) {
    // Body of an OAuth error is a short JSON like {"error":"invalid_grant"}; never contains our secrets.
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ");
    } catch {
      /* ignore */
    }
    if (res.status >= 500) throw new YahooError("NETWORK", `Yahoo token endpoint error ${res.status}`, res.status);
    throw new YahooError("AUTH", `Yahoo rejected the token request (${res.status}${detail ? `, ${detail}` : ""}). Run \`pnpm yahoo:auth\` again.`, res.status);
  }
  let parsed;
  try {
    parsed = tokenResponse.parse(await res.json());
  } catch {
    throw new YahooError("PARSE", "Unexpected token response from Yahoo");
  }
  const refresh = parsed.refresh_token ?? prev?.refresh_token;
  if (!refresh) throw new YahooError("PARSE", "Yahoo token response had no refresh_token");
  return {
    access_token: parsed.access_token,
    refresh_token: refresh,
    token_type: parsed.token_type ?? "bearer",
    expires_at: now + parsed.expires_in * 1000,
  };
}

export function exchangeCode(code: string, cfg: YahooConfig = getYahooConfig(), fetchFn: FetchLike = fetch): Promise<YahooTokens> {
  return postToken({ grant_type: "authorization_code", redirect_uri: cfg.redirectUri, code: code.trim() }, cfg, fetchFn);
}

export function refreshTokens(prev: YahooTokens, cfg: YahooConfig = getYahooConfig(), fetchFn: FetchLike = fetch): Promise<YahooTokens> {
  return postToken({ grant_type: "refresh_token", redirect_uri: cfg.redirectUri, refresh_token: prev.refresh_token }, cfg, fetchFn, prev);
}

const SKEW_MS = 60_000;
let inflight: Promise<YahooTokens> | null = null;

/** Refreshes (and persists) when expired / about to expire, or when `force`. Concurrent calls share one refresh. */
export async function refreshIfNeeded(opts: { force?: boolean; file?: string; fetchFn?: FetchLike; now?: number } = {}): Promise<YahooTokens> {
  const file = opts.file ?? tokenFilePath();
  const tokens = loadTokens(file);
  if (!tokens) throw new YahooError("AUTH", "No Yahoo tokens found. Run `pnpm yahoo:auth` first. Manual drafting still works.");
  if (!opts.force && tokens.expires_at - (opts.now ?? Date.now()) > SKEW_MS) return tokens;
  if (!inflight) {
    inflight = refreshTokens(tokens, getYahooConfig(), opts.fetchFn ?? fetch)
      .then((t) => {
        saveTokens(t, file);
        return t;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getAccessToken(): Promise<string> {
  return (await refreshIfNeeded()).access_token;
}

export interface TokenStatus {
  tokensPresent: boolean;
  expired: boolean | null;
  expiresAt: string | null;
  hasRefreshToken: boolean;
}

export function tokenStatus(file = tokenFilePath(), now = Date.now()): TokenStatus {
  try {
    const t = loadTokens(file);
    if (!t) return { tokensPresent: false, expired: null, expiresAt: null, hasRefreshToken: false };
    return { tokensPresent: true, expired: t.expires_at <= now, expiresAt: new Date(t.expires_at).toISOString(), hasRefreshToken: true };
  } catch {
    return { tokensPresent: false, expired: null, expiresAt: null, hasRefreshToken: false };
  }
}
