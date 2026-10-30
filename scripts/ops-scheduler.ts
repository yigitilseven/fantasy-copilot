/**
 * Always-on scheduler (no host crontab): morning brief (weekly plan on WEEKLY_PLAN_DAY), optional injury alerts, Claude token expiry check.
 *   tsx scripts/ops-scheduler.ts            run forever (the `scheduler` container)
 *   tsx scripts/ops-scheduler.ts brief      generate + send the daily brief now
 *   tsx scripts/ops-scheduler.ts weekly     generate + send the weekly plan now
 *   tsx scripts/ops-scheduler.ts rebrief    rewrite today's brief now if your roster changed since (no push)
 *   tsx scripts/ops-scheduler.ts injury     check roster injury events now
 *   tsx scripts/ops-scheduler.ts token      token expiry check now
 * Reads everything from env (see .env.example).
 */
import path from "node:path";
import { runClaude } from "../src/ops/claude-runner";
import { DEFAULT_LIMITS, type LimiterState } from "../src/ops/injury-watch";
import { DAILY_BRIEF, WEEKLY_PLAN, runBriefJob, runInjuryJob, runRebriefCheck, runTokenCheck, type JobDeps, type RebriefState } from "../src/ops/jobs";
import { notify } from "../src/ops/notify";
import { readJsonFile, writeJsonFile } from "../src/ops/state-store";
import { isLocalWeekday, jitteredDelayMs, localDay, nextDailyAt, parseHHMM } from "../src/ops/timing";

const env = process.env;
const tz = env.TZ || "UTC";
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const log = (l: string) => console.log(`${new Date().toISOString()} [scheduler] ${l}`);

const stateFile = env.OPS_STATE_FILE || "data/ops/scheduler.json";
interface SchedState { lastBriefDay?: string; tokenWarnedDay?: string; limiter: LimiterState; rebrief?: RebriefState }
const emptyLimiter = (): LimiterState => ({ seen: {}, sent: [], takes: [] });
const load = () => readJsonFile<SchedState>(stateFile, { limiter: emptyLimiter() });
const save = (s: SchedState) => writeJsonFile(stateFile, s);

const workerUrl = env.WORKER_URL;
const deps: JobDeps = {
  appUrl: (env.APP_URL || "http://app:3000").replace(/\/$/, ""),
  reportsDir: env.REPORTS_DIR || "data/reports",
  claudeCwd: env.CLAUDE_CWD || env.REPORTS_DIR || "data/reports",
  promptsDir: env.PROMPTS_DIR || path.resolve("prompts"),
  fetch,
  runClaude,
  notify: (m) => notify(m),
  log,
  now: Date.now,
  briefMaxChars: num(env.BRIEF_MAX_CHARS, 1500),
  claude: {
    bin: env.CLAUDE_BIN || "claude",
    model: env.CLAUDE_MODEL || undefined,
    timeoutMs: num(env.CLAUDE_TIMEOUT_SECONDS, 300) * 1000,
    extraArgs: (env.CLAUDE_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
  },
  workerSync:
    workerUrl && env.BRIEF_SYNC_FIRST !== "0"
      ? async () => {
          const r = await fetch(`${workerUrl.replace(/\/$/, "")}/sync?wait=1`, { method: "POST", headers: env.WORKER_TOKEN ? { Authorization: `Bearer ${env.WORKER_TOKEN}` } : {}, signal: AbortSignal.timeout(14 * 60_000) });
          log(`worker sync before brief: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        }
      : undefined,
};

/** Weekday of the weekly strategy plan (Yahoo weeks start on Monday); empty = only daily briefs. */
const weeklyDay = env.WEEKLY_PLAN_DAY ?? "Mon";
const weekly = { ...WEEKLY_PLAN, maxChars: num(env.WEEKLY_PLAN_MAX_CHARS, 2800) };

async function brief(trigger = "scheduled", which = isLocalWeekday(Date.now(), tz, weeklyDay) ? weekly : DAILY_BRIEF) {
  const r = await runBriefJob(deps, trigger, which);
  const s = load();
  s.lastBriefDay = localDay(Date.now(), tz);
  save(s);
  log(`${which.kind} sent=${r.sent} claude=${r.usedClaude}${r.failure ? ` failure=${r.failure}` : ""}`);
}
/** Rewrites today's brief (no push) when your roster changed after it was written. */
async function rebrief() {
  const today = localDay(Date.now(), tz);
  const r = await runRebriefCheck(deps, load().rebrief ?? {}, today, { daily: DAILY_BRIEF, weekly });
  if (r.ran) save({ ...load(), rebrief: r.state });
}

async function injury() {
  const r = await runInjuryJob(deps, {
    loadLimiter: () => load().limiter,
    saveLimiter: (l) => save({ ...load(), limiter: l }),
    useClaude: env.INJURY_CLAUDE !== "0",
  });
  log(`injury: events=${r.events} sent=${r.sent} take=${r.take}`);
}
async function token() {
  const s = load();
  const today = localDay(Date.now(), tz);
  if (await runTokenCheck(deps, env.CLAUDE_TOKEN_CREATED, s.tokenWarnedDay, today)) save({ ...load(), tokenWarnedDay: today });
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${deps.appUrl}/api/health`, { signal: AbortSignal.timeout(5000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  log("app not reachable yet; continuing anyway");
}

async function guarded(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    log(`${name} crashed: ${e instanceof Error ? e.stack : e}`);
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "brief") return brief("manual", DAILY_BRIEF);
  if (cmd === "weekly") return brief("manual", weekly);
  if (cmd === "injury") return injury();
  if (cmd === "token") return token();
  if (cmd === "rebrief") return rebrief();
  if (cmd) throw new Error(`unknown command "${cmd}"`);

  const briefAt = env.BRIEF_TIME || "08:30";
  if (!parseHHMM(briefAt)) throw new Error(`BRIEF_TIME "${briefAt}" must be HH:MM`);
  const watchMin = num(env.INJURY_WATCH_MINUTES, 0);
  log(`start: tz=${tz} brief at ${briefAt}, weekly plan on ${weeklyDay || "never"}, injury watch every ${watchMin || "never"} min, claude=${env.CLAUDE_CODE_OAUTH_TOKEN ? "token set" : "NO TOKEN"}`);
  if (env.ANTHROPIC_API_KEY) log("WARNING: ANTHROPIC_API_KEY is set; it is ignored for Claude runs (it would bill the API instead of your subscription)");
  await waitForApp();

  let nextBrief = nextDailyAt(Date.now(), briefAt, tz);
  const s0 = load();
  const today = localDay(Date.now(), tz);
  const lastScheduled = nextBrief - 86_400_000;
  if (s0.lastBriefDay !== today && Date.now() - lastScheduled < 6 * 3_600_000 && Date.now() >= lastScheduled) nextBrief = Date.now() + 60_000; // missed it while down
  let nextInjury = watchMin > 0 ? Date.now() + 5 * 60_000 : Infinity;
  let nextToken = Date.now() + 2 * 60_000;
  const rebriefMin = num(env.REBRIEF_MINUTES, 15);
  let nextRebrief = rebriefMin > 0 ? Date.now() + 3 * 60_000 : Infinity;
  const tokenAt = "09:00";

  for (;;) {
    const now = Date.now();
    if (now >= nextBrief) {
      nextBrief = nextDailyAt(now + 60_000, briefAt, tz);
      await guarded("brief", () => brief());
    }
    if (now >= nextInjury) {
      nextInjury = Date.now() + jitteredDelayMs(watchMin * 60_000, watchMin * 60_000 * 0.1);
      await guarded("injury", injury);
    }
    if (now >= nextRebrief) {
      nextRebrief = Date.now() + rebriefMin * 60_000;
      await guarded("rebrief", rebrief);
    }
    if (now >= nextToken) {
      nextToken = nextDailyAt(Date.now() + 60_000, tokenAt, tz);
      await guarded("token", token);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
}
void DEFAULT_LIMITS;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
