import fs from "node:fs";
import path from "node:path";
type Env = Record<string, string | undefined>;
import { clip, notify as realNotify, type NotifyMessage, type NotifyResult } from "./notify";
import { runClaude as realRunClaude, tokenExpiry, type ClaudeResult, type RunClaudeOpts } from "./claude-runner";
import { applyLimits, formatInjuryAlert, formatInjuryEvent, recordSent, takeAllowed, type InjuryEvent, type LimiterState, DEFAULT_LIMITS } from "./injury-watch";

/** Scheduler jobs (morning brief, injury alerts, token expiry). Every side effect is injected so the flows are testable with mocks. */
export interface JobDeps {
  appUrl: string;
  /** read-write folder where the engine outputs are written (brief.json, report.json, ...) */
  reportsDir: string;
  /** folder Claude runs in: the same files, mounted read-only in production */
  claudeCwd: string;
  promptsDir: string;
  fetch: typeof fetch;
  runClaude: (o: RunClaudeOpts) => Promise<ClaudeResult>;
  notify: (m: NotifyMessage) => Promise<NotifyResult[]>;
  log: (l: string) => void;
  now: () => number;
  claude: { bin?: string; model?: string; timeoutMs?: number; extraArgs?: string[]; env?: Env };
  /** optional: ask the browser worker for a fresh Yahoo sync first (best effort) */
  workerSync?: () => Promise<void>;
  briefMaxChars: number;
}

export const CHAT_LIMIT = 1500;

/** Short push text from the engine brief: "62% this week · Start: X · Move: add Y" (the full text is on the Season page). */
export function pushSummary(b: { headline?: string; sections?: { title: string; lines: string[] }[] } | null | undefined): string {
  if (!b) return "Your daily brief is ready.";
  const parts: string[] = [];
  const m = /matchup (\d+)%/.exec(b.headline ?? "");
  if (m) parts.push(`${m[1]}% this week`);
  const sec = (t: string) => b.sections?.find((x) => x.title.toLowerCase().startsWith(t));
  const starts = (sec("today")?.lines ?? []).map((l) => /^START\s+(.+?)(?: at \S+)?:/.exec(l)?.[1]).filter((x): x is string => !!x);
  if (starts.length) parts.push(`Start: ${starts.slice(0, 2).join(", ")}`);
  const mv = (sec("moves")?.lines ?? []).find((l) => /: add /.test(l));
  const add = mv && /: add (.+?) \(/.exec(mv)?.[1];
  if (add) parts.push(`Move: add ${add}`);
  return parts.length ? parts.join(" · ") : clip(b.headline ?? "Your daily brief is ready.", 170);
}

async function getJson(d: JobDeps, p: string, init?: RequestInit): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await d.fetch(d.appUrl + p, { ...init, signal: AbortSignal.timeout(120_000) });
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: { raw: t } };
  }
}

function writeAtomic(dir: string, name: string, content: string) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f + ".tmp", content);
  fs.renameSync(f + ".tmp", f);
}

/** Plain engine brief for chat (fallback and the base of every message): headline, lineup moves, top moves, alerts. */
export function plainBrief(b: { headline: string; sections: { title: string; lines: string[] }[] }, max = 3500): string {
  const pick = (t: string) => b.sections.find((s) => s.title.toLowerCase().startsWith(t));
  const out = [b.headline];
  const lineup = pick("today");
  if (lineup) out.push("", "LINEUP", ...lineup.lines.filter((l) => /^(START|SIT)\b|IL|have a game/.test(l)).slice(0, 10).map((l) => `- ${l}`));
  const wk = pick("this week");
  if (wk) out.push("", "WEEK", ...wk.lines.slice(0, 3).map((l) => `- ${l}`));
  const al = pick("alerts");
  if (al) out.push("", "ALERTS", ...al.lines.slice(0, 5).map((l) => `- ${l}`));
  const mv = pick("moves");
  if (mv) out.push("", "MOVES", ...mv.lines.filter((l) => !l.startsWith("    ")).slice(0, 4).map((l) => `- ${l}`));
  return clip(out.join("\n"), max);
}

export interface EngineFiles { briefText: string; brief: any; ok: boolean; error?: string } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs the upkeep in the app, then writes brief.json / brief.txt / report.json / sync-status.json / trades.json / context.json into reportsDir. */
export async function generateEngineFiles(d: JobDeps, extra: Record<string, unknown> = {}): Promise<EngineFiles> {
  try {
    await getJson(d, "/api/season/refresh", { method: "POST" }).catch((e) => d.log(`upkeep failed: ${e}`));
    const brief = await getJson(d, "/api/season/brief?refresh=1");
    if (brief.status !== 200) return { briefText: "", brief: null, ok: false, error: brief.body?.error ?? `brief HTTP ${brief.status}` };
    const text = await d.fetch(`${d.appUrl}/api/season/brief?format=text`).then((r) => r.text());
    const report = await getJson(d, "/api/season/report").catch(() => ({ status: 0, body: null }));
    const sync = await getJson(d, "/api/season/sync-status").catch(() => ({ status: 0, body: null }));
    const trades = await getJson(d, "/api/season/trades").catch(() => ({ status: 0, body: null }));
    writeAtomic(d.reportsDir, "brief.json", JSON.stringify(brief.body, null, 1));
    writeAtomic(d.reportsDir, "brief.txt", text);
    if (report.status === 200) writeAtomic(d.reportsDir, "report.json", JSON.stringify(report.body, null, 1));
    if (sync.status === 200) writeAtomic(d.reportsDir, "sync-status.json", JSON.stringify(sync.body, null, 1));
    if (trades.status === 200) writeAtomic(d.reportsDir, "trades.json", JSON.stringify(trades.body, null, 1));
    writeAtomic(d.reportsDir, "context.json", JSON.stringify({ generatedAt: new Date(d.now()).toISOString(), tz: process.env.TZ ?? null, ...extra }, null, 1));
    return { briefText: text, brief: brief.body, ok: true };
  } catch (e) {
    return { briefText: "", brief: null, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const readPrompt = (d: JobDeps, name: string) => fs.readFileSync(path.join(d.promptsDir, name), "utf8");

export interface BriefOutcome { sent: boolean; usedClaude: boolean; failure?: string; text: string }

/** Which morning message to write: the daily brief, or the longer weekly strategy plan (same engine files, different prompt). */
export interface BriefKind { kind: "daily-brief" | "weekly-plan"; prompt: string; title: string; maxChars?: number }
export const DAILY_BRIEF: BriefKind = { kind: "daily-brief", prompt: "daily-brief.md", title: "Daily brief" };
export const WEEKLY_PLAN: BriefKind = { kind: "weekly-plan", prompt: "weekly-plan.md", title: "Weekly plan" };

export interface BriefRunOpts {
  /** Store the new text but send no push (a rewrite after a roster change). */
  silent?: boolean;
  /** Skip the Yahoo sync before writing (the data was just synced). */
  skipSync?: boolean;
}

export async function runBriefJob(d: JobDeps, trigger = "scheduled", which: BriefKind = DAILY_BRIEF, opts: BriefRunOpts = {}): Promise<BriefOutcome> {
  if (d.workerSync && !opts.skipSync) await d.workerSync().catch((e) => d.log(`worker sync before brief failed: ${e}`));
  const eng = await generateEngineFiles(d, { kind: which.kind, trigger });
  if (!eng.ok) {
    const text = `${which.title} could not be generated: ${eng.error}`;
    await d.notify({ title: `${which.title} failed`, body: text, level: "warn" });
    return { sent: true, usedClaude: false, failure: eng.error, text };
  }
  const prompt = readPrompt(d, which.prompt);
  const r = await d.runClaude({ prompt, cwd: d.claudeCwd, ...d.claude, timeoutMs: d.claude.timeoutMs ?? 300_000 });
  let body: string;
  let usedClaude = false;
  if (r.ok) {
    body = clip(r.text, which.maxChars ?? d.briefMaxChars);
    usedClaude = true;
  } else {
    d.log(`claude failed (${r.failure}): ${r.detail}`);
    const why = r.failure === "auth" || r.failure === "no_token" ? "Claude login/token problem (renew with `claude setup-token`)" : r.failure === "rate_limit" ? "Claude rate limit" : `Claude unavailable (${r.failure})`;
    body = `${plainBrief(eng.brief)}\n\n(Plain engine brief: ${why}.)`;
  }
  // the full text is stored so the Season page shows it ("Claude analysis", or the engine brief when Claude was unavailable)
  await getJson(d, "/api/season/claude-brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body, usedClaude, note: usedClaude ? undefined : r.failure, kind: which.kind }) }).catch((e) => d.log(`could not store brief: ${e}`));
  if (opts.silent) return { sent: false, usedClaude, failure: r.failure, text: body };
  const res = await d.notify({ title: usedClaude ? which.title : `${which.title} (engine only)`, body, pushBody: pushSummary(eng.brief), url: "/today/brief", tag: which.kind });
  return { sent: res.some((x) => x.ok), usedClaude, failure: r.failure, text: body };
}

export interface RebriefState { day?: string; count?: number; lastAt?: number }
export const REBRIEF_LIMITS = { maxPerDay: 6, minGapMs: 30 * 60_000 };

/**
 * Today's brief recommends moves for a roster you no longer have (you added / dropped since): write it again, quietly (no push).
 * Only after the morning brief exists, at most `maxPerDay` times a day and `minGapMs` apart. Returns the new state when it ran.
 */
export async function runRebriefCheck(d: JobDeps, st: RebriefState, today: string, kinds: { daily: BriefKind; weekly: BriefKind }, limits = REBRIEF_LIMITS): Promise<{ ran: boolean; state: RebriefState; reason?: string }> {
  const cur = await getJson(d, "/api/season/claude-brief").catch(() => ({ status: 0, body: null }));
  if (cur.status !== 200 || !cur.body?.brief) return { ran: false, state: st, reason: "no brief today" };
  if (!cur.body.outdated) return { ran: false, state: st, reason: "up to date" };
  const s: RebriefState = st.day === today ? st : { day: today, count: 0 };
  if ((s.count ?? 0) >= limits.maxPerDay) return { ran: false, state: s, reason: "daily cap" };
  if (s.lastAt && d.now() - s.lastAt < limits.minGapMs) return { ran: false, state: s, reason: "too soon" };
  const which = cur.body.brief.kind === kinds.weekly.kind ? kinds.weekly : kinds.daily;
  const r = await runBriefJob(d, "roster-change", which, { silent: true, skipSync: true });
  d.log(`rebrief after roster change: claude=${r.usedClaude}${r.failure ? ` failure=${r.failure}` : ""}`);
  return { ran: true, state: { day: today, count: (s.count ?? 0) + 1, lastAt: d.now() } };
}

export interface InjuryJobIO {
  loadLimiter: () => LimiterState;
  saveLimiter: (s: LimiterState) => void;
  /** also ask the app to refresh the news first (default true) */
  refreshNews?: boolean;
  useClaude: boolean;
}

export async function runInjuryJob(d: JobDeps, io: InjuryJobIO): Promise<{ events: number; sent: number; take: boolean }> {
  if (io.refreshNews !== false) await getJson(d, "/api/news/refresh", { method: "POST" }).catch((e) => d.log(`news refresh failed: ${e}`));
  const pending = await getJson(d, "/api/ops/injury-events");
  const events: InjuryEvent[] = pending.status === 200 ? pending.body.events ?? [] : [];
  if (!events.length) return { events: 0, sent: 0, take: false };
  const now = d.now();
  const st = io.loadLimiter();
  const lim = applyLimits(events, st, now, DEFAULT_LIMITS);
  const ack = (list: readonly InjuryEvent[]) => list.length && getJson(d, "/api/ops/injury-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: list.map((e) => e.id) }) }).catch(() => undefined);
  await ack(lim.suppressed);
  if (!lim.send.length) return { events: events.length, sent: 0, take: false };

  const alert = formatInjuryAlert(lim.send);
  let body = alert.body;
  let take = false;
  if (io.useClaude && takeAllowed(st, now, DEFAULT_LIMITS)) {
    const eng = await generateEngineFiles(d, { kind: "injury-alert", events: lim.send.map(formatInjuryEvent) });
    if (eng.ok) {
      writeAtomic(d.reportsDir, "injury-events.json", JSON.stringify(lim.send, null, 1));
      const r = await d.runClaude({ prompt: readPrompt(d, "injury-alert.md"), cwd: d.claudeCwd, ...d.claude, timeoutMs: d.claude.timeoutMs ?? 240_000 });
      if (r.ok) {
        body += `\n\nTake: ${clip(r.text, 700)}`;
        take = true;
      } else d.log(`claude take skipped (${r.failure}): ${r.detail}`);
    }
  }
  const res = await d.notify({ title: alert.title, body, pushBody: take ? body.split("\n\nTake: ")[1] || alert.body : alert.body.split("\n").join("; "), url: "/moves", tag: "injury", level: lim.send.some((e) => e.direction === "worse") ? "alert" : "info" });
  if (res.some((x) => x.ok)) {
    await ack(lim.send);
    io.saveLimiter(recordSent(st, lim.send, now, take));
  }
  return { events: events.length, sent: res.some((x) => x.ok) ? lim.send.length : 0, take };
}

/** Warns once a day from 14 days before the 1-year Claude token runs out. Returns true when a warning was sent. */
export async function runTokenCheck(d: JobDeps, createdIso: string | undefined, lastWarnedDay: string | undefined, today: string): Promise<boolean> {
  const t = tokenExpiry(createdIso, d.now());
  if (!t.known) {
    d.log("CLAUDE_TOKEN_CREATED not set: cannot track the token expiry (set it to the date you ran `claude setup-token`)");
    return false;
  }
  if (!t.warn || lastWarnedDay === today) return false;
  const text = t.daysLeft! >= 0 ? `Your Claude token expires on ${t.expiresAt} (${t.daysLeft} days left). Run \`claude setup-token\`, put the new token in .env (CLAUDE_CODE_OAUTH_TOKEN) and the date in CLAUDE_TOKEN_CREATED, then \`docker compose up -d\`.` : `Your Claude token expired on ${t.expiresAt}. Briefs fall back to the plain engine text until you renew it with \`claude setup-token\`.`;
  const res = await d.notify({ title: "Claude token expiry", body: text, pushBody: `Claude token expires ${t.expiresAt}: renew with claude setup-token.`, url: "/settings", tag: "token", level: "warn" });
  return res.some((x) => x.ok);
}

export { realNotify, realRunClaude };
