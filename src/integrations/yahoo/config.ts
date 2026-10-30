import fs from "node:fs";
import path from "node:path";
import { YahooError } from "./errors";

export const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
export const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
export const YAHOO_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

export interface YahooConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Loads .env.local for CLI scripts (Next.js does it itself for route handlers). Never logs values. */
export function loadEnvLocal(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env.local");
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    /* malformed .env.local: fall through, missing vars are reported by getYahooConfig */
  }
}

export function hasYahooCredentials(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.YAHOO_CLIENT_ID?.trim() && env.YAHOO_CLIENT_SECRET?.trim());
}

export function getYahooConfig(env: Record<string, string | undefined> = process.env): YahooConfig {
  const clientId = env.YAHOO_CLIENT_ID?.trim();
  const clientSecret = env.YAHOO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new YahooError(
      "AUTH",
      "Yahoo credentials missing: set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env.local (see .env.example). Manual drafting still works.",
    );
  return { clientId, clientSecret, redirectUri: env.YAHOO_REDIRECT_URI?.trim() || "oob" };
}

export function tokenFilePath(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  return path.resolve(cwd, env.YAHOO_TOKEN_FILE?.trim() || "data/yahoo-tokens.json");
}
