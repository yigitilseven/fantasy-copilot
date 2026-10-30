import readline from "node:readline/promises";
import { getYahooConfig, loadEnvLocal, tokenFilePath } from "../src/integrations/yahoo/config";
import { isYahooError } from "../src/integrations/yahoo/errors";
import { buildAuthUrl, exchangeCode, saveTokens } from "../src/integrations/yahoo/oauth";

async function main() {
  loadEnvLocal();
  const cfg = getYahooConfig();
  console.log("1. Open this URL in a browser, sign in to Yahoo, and approve access:\n");
  console.log(buildAuthUrl(cfg));
  console.log(
    cfg.redirectUri === "oob"
      ? "\n2. Yahoo shows a verification code. Paste it below.\n"
      : `\n2. Yahoo redirects to ${cfg.redirectUri}/?code=... — the page will fail to load; that's expected.\n   Copy the whole address from the browser bar (or just the code) and paste it below.\n`,
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = extractCode(await rl.question("Code or URL: "));
  rl.close();
  if (!code) throw new Error("No code entered.");
  const tokens = await exchangeCode(code, cfg);
  saveTokens(tokens);
  console.log(`\nSaved tokens to ${tokenFilePath()} (expires ${new Date(tokens.expires_at).toISOString()}). Refresh is automatic.`);
}

/** Accepts a bare code or the full redirect URL containing ?code=. */
function extractCode(input: string): string {
  const s = input.trim();
  if (!s.includes("code=")) return s;
  try {
    return new URL(s).searchParams.get("code") ?? "";
  } catch {
    return /code=([^&\s]+)/.exec(s)?.[1] ?? "";
  }
}

main().catch((e) => {
  console.error(isYahooError(e) ? `[${e.code}] ${e.message}` : `Error: ${(e as Error).message}`);
  process.exit(1);
});
