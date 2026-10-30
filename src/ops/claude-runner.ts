import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Runs the Claude Code CLI headless with the user's subscription (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
 * Never uses --bare (bare mode ignores the OAuth token) and strips ANTHROPIC_API_KEY (it would take precedence and bill the API).
 * Read-only: tools are limited to Read and permissions are "dontAsk" (anything not allowed is denied, nothing waits for a human).
 */
type Env = Record<string, string | undefined>;
export type ClaudeFailure = "auth" | "rate_limit" | "timeout" | "missing" | "no_token" | "empty" | "error";

export interface ClaudeResult {
  ok: boolean;
  text: string;
  failure?: ClaudeFailure;
  detail?: string;
  exitCode?: number | null;
  costUsd?: number;
}
export interface RunClaudeOpts {
  prompt: string;
  /** Working directory = the (read-only mounted) folder with the data files. */
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  model?: string;
  env?: Env;
  /** Extra CLI flags (CLAUDE_EXTRA_ARGS), e.g. "--permission-prompts none" on CLI versions that have that flag. */
  extraArgs?: string[];
}

export function buildClaudeArgs(o: Pick<RunClaudeOpts, "model" | "extraArgs"> = {}): string[] {
  const a = ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--allowedTools", "Read"];
  if (o.model) a.push("--model", o.model);
  if (o.extraArgs?.length) a.push(...o.extraArgs);
  return a;
}

export function buildClaudeEnv(base: Env): { env: Env; hadApiKey: boolean } {
  const env = { ...base };
  const hadApiKey = !!env.ANTHROPIC_API_KEY || !!env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1";
  return { env, hadApiKey };
}

export function classifyFailure(text: string): ClaudeFailure {
  if (/oauth|authenticat|unauthori[sz]ed|\b401\b|\b403\b|invalid (api key|token|x-api-key)|not logged in|please run \/?login|token (has )?expired|session expired|credentials/i.test(text)) return "auth";
  if (/rate.?limit|\b429\b|usage limit|limit reached|too many requests|overloaded|\b529\b|quota/i.test(text)) return "rate_limit";
  return "error";
}

/** `claude -p --output-format json` prints one result object (or an array of events); returns the final result event. */
export function parseClaudeOutput(stdout: string): { text: string; isError: boolean; costUsd?: number } | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    const last = stdout.trim().split("\n").filter(Boolean).pop();
    try {
      v = last ? JSON.parse(last) : null;
    } catch {
      return null;
    }
  }
  const ev = Array.isArray(v) ? [...v].reverse().find((e) => e && typeof e === "object" && (e as { type?: string }).type === "result") : v;
  if (!ev || typeof ev !== "object") return null;
  const o = ev as { result?: unknown; is_error?: boolean; total_cost_usd?: number };
  return { text: typeof o.result === "string" ? o.result : "", isError: !!o.is_error, costUsd: o.total_cost_usd };
}

/** A `claude login` done inside the container (stored in the claude-config volume) works as well as the env token. */
function hasStoredLogin(env: Env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR || (env.HOME ? path.join(env.HOME, ".claude") : null);
  return !!dir && fs.existsSync(path.join(dir, ".credentials.json"));
}

export function runClaude(o: RunClaudeOpts): Promise<ClaudeResult> {
  const base = o.env ?? process.env;
  if (!base.CLAUDE_CODE_OAUTH_TOKEN?.trim() && !hasStoredLogin(base)) return Promise.resolve({ ok: false, text: "", failure: "no_token", detail: "CLAUDE_CODE_OAUTH_TOKEN is not set and there is no stored `claude login` (run `claude setup-token`)" });
  const { env } = buildClaudeEnv(base);
  const timeoutMs = o.timeoutMs ?? 300_000;
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let timedOut = false;
    const finish = (r: ClaudeResult) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const child = spawn(o.bin ?? "claude", buildClaudeArgs(o), { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, text: "", failure: e.code === "ENOENT" ? "missing" : "error", detail: e.message }));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, text: "", failure: "timeout", detail: `no answer after ${Math.round(timeoutMs / 1000)}s`, exitCode: code });
      const parsed = parseClaudeOutput(out);
      const text = parsed?.text.trim() ?? "";
      if (code === 0 && parsed && !parsed.isError) {
        return text ? finish({ ok: true, text, exitCode: code, costUsd: parsed.costUsd }) : finish({ ok: false, text: "", failure: "empty", detail: "empty answer", exitCode: code });
      }
      const detail = (text || err || out).trim().slice(0, 400);
      finish({ ok: false, text: "", failure: classifyFailure(detail), detail: detail || `exit ${code}`, exitCode: code });
    });
    child.stdin.end(o.prompt);
  });
}

/** Token created date (YYYY-MM-DD) + 365 days; warns from 14 days before. */
export function tokenExpiry(createdIso: string | undefined, nowMs: number, warnDays = 14): { known: boolean; expiresAt?: string; daysLeft?: number; warn: boolean } {
  const t = createdIso ? Date.parse(createdIso) : NaN;
  if (Number.isNaN(t)) return { known: false, warn: false };
  const exp = t + 365 * 86_400_000;
  const daysLeft = Math.floor((exp - nowMs) / 86_400_000);
  return { known: true, expiresAt: new Date(exp).toISOString().slice(0, 10), daysLeft, warn: daysLeft <= warnDays };
}
