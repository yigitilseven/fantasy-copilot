/**
 * Yahoo browser worker (runs in the `browser-worker` container, display = Xvfb, viewed through noVNC).
 *
 *  - Starts a normal Chromium with a PERSISTENT profile and a local DevTools port. YOU log in to Yahoo by hand through noVNC; nothing is typed
 *    for you, no captcha / 2FA / bot check is ever bypassed.
 *  - Every ~2 h (+ random jitter) it attaches over CDP, opens ONE league page, injects the built userscript (so the tested parsers and the
 *    autonomous read-only league sync run unchanged), waits until the app reports the sync, then closes the page. It never clicks on Yahoo.
 *  - Login wall / captcha / verification -> stop, set the needsLogin flag, alert once with the noVNC link.
 *  - HTTP: GET /healthz, GET /status, POST /sync[?wait=1]   (Bearer WORKER_TOKEN when set)
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { COLLECT_SNAPSHOT_JS } from "../src/ops/login-wall";
import { notify } from "../src/ops/notify";
import { buildInitScript, makeAppForwarder } from "../src/ops/page-init";
import { readJsonFile, writeJsonFile } from "../src/ops/state-store";
import { runSync, type SyncDeps, type WorkerState } from "../src/ops/sync-run";
import { decideRun, jitteredDelayMs, runsOnLocalDay } from "../src/ops/timing";

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const log = (l: string) => console.log(`${new Date().toISOString()} [worker] ${l}`);

const LEAGUE_ID = env.YAHOO_LEAGUE_ID?.trim() ?? "";
const TEAM_ID = env.YAHOO_TEAM_ID?.trim() ?? "";
const APP_URL = (env.APP_URL || "http://app:3000").replace(/\/$/, "");
const tz = env.TZ || "UTC";
const cdpPort = num(env.CDP_PORT, 9222);
const profileDir = env.CHROMIUM_PROFILE_DIR || "/profile";
const stateFile = env.WORKER_STATE_FILE || "/state/worker.json";
const userscriptPath = env.USERSCRIPT_PATH || path.resolve("extension/yahoo-draft-reader.user.js");
const novncUrl = env.NOVNC_PUBLIC_URL || (env.DOMAIN ? `https://${env.DOMAIN}/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify` : "http://localhost:6080/vnc.html?autoconnect=1&resize=scale (through your SSH tunnel)");
const leagueUrl = `https://basketball.fantasysports.yahoo.com/nba/${LEAGUE_ID}${TEAM_ID ? `/${TEAM_ID}` : ""}`;

const cfg = {
  everyMs: num(env.SYNC_EVERY_HOURS, 2) * 3_600_000,
  jitterMs: num(env.SYNC_JITTER_MINUTES, 20) * 60_000,
  maxPerDay: num(env.MAX_SYNCS_PER_DAY, 14),
  quietHours: env.SYNC_QUIET_HOURS || "",
  loginRetryMs: num(env.LOGIN_RETRY_HOURS, 6) * 3_600_000,
  minGapMs: num(env.MIN_SYNC_GAP_MINUTES, 20) * 60_000,
  timeoutMs: num(env.SYNC_TIMEOUT_MINUTES, 10) * 60_000,
};

let state: WorkerState = readJsonFile<WorkerState>(stateFile, { needsLogin: false, runs: [] });
const persist = () => writeJsonFile(stateFile, state);

// ---------------------------------------------------------------- browser process
let chrome: ChildProcess | null = null;
let stopping = false;

function startChromium() {
  const exe = env.CHROMIUM_PATH || chromium.executablePath();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--window-position=0,0",
    `--window-size=${env.SCREEN_WIDTH || 1366},${env.SCREEN_HEIGHT || 850}`,
    "--disable-dev-shm-usage",
    ...(process.getuid?.() === 0 || env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    leagueUrl,
  ];
  log(`starting Chromium (${exe})`);
  chrome = spawn(exe, args, { stdio: "ignore", env: { ...env, DISPLAY: env.DISPLAY || ":99" } });
  chrome.on("exit", (code) => {
    log(`Chromium exited (${code})`);
    chrome = null;
    if (!stopping) setTimeout(startChromium, 3000);
  });
}

async function connect(): Promise<Browser> {
  let last: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- one sync
let running: Promise<{ outcome: string; detail?: string }> | null = null;

function makeDeps(browser: Browser, full = false): SyncDeps {
  const userscript = fs.readFileSync(userscriptPath, "utf8");
  const forward = makeAppForwarder(APP_URL);
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    alert: async (text) => {
      await notify({ title: "Yahoo needs you to log in again", body: text, pushBody: "Tap to open the remote browser, then log in to Yahoo by hand.", url: novncUrl, tag: "yahoo-login", level: "alert" });
    },
    async syncStatus() {
      const r = await fetch(`${APP_URL}/api/season/sync-status`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`sync-status HTTP ${r.status}`);
      return (await r.json()) as never;
    },
    async openPage(url) {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      const binding = `__fdc_${Math.random().toString(36).slice(2)}`;
      await page.exposeFunction(binding, forward);
      await page.addInitScript(buildInitScript({ userscript, origin: APP_URL, binding, forceSync: true, fullSync: full }));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // A background tab reports visibilityState=hidden and the userscript would not start. A new tab is normally in front already, so this is
      // best effort and bounded (calling it before goto() was seen to stall navigation in headless Chromium).
      await Promise.race([page.bringToFront(), new Promise((r) => setTimeout(r, 5000))]).catch(() => undefined);
      await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => undefined);
      return {
        snapshot: async () => (await page.evaluate(COLLECT_SNAPSHOT_JS)) as never,
        close: () => page.close(),
      };
    },
  };
}

async function doSync(manual: boolean): Promise<{ outcome: string; detail?: string }> {
  if (!LEAGUE_ID) return { outcome: "error", detail: "YAHOO_LEAGUE_ID is not set" };
  if (running) return { outcome: "busy", detail: "a sync is already running" };
  const d = decideRun({ now: Date.now(), tz, history: state.runs, maxPerDay: cfg.maxPerDay, quietHours: cfg.quietHours, manual, needsLogin: state.needsLogin, lastRunAt: state.lastRunAt, loginRetryMs: cfg.loginRetryMs, minGapMs: manual ? Math.min(cfg.minGapMs, 5 * 60_000) : cfg.minGapMs });
  if (!d.run) {
    log(`skip (${d.reason})`);
    return { outcome: "skipped", detail: d.reason };
  }
  running = (async () => {
    let browser: Browser | null = null;
    try {
      browser = await connect();
      const res = await runSync(makeDeps(browser, manual), { leagueUrl, leagueId: LEAGUE_ID, novncUrl, timeoutMs: cfg.timeoutMs, pollMs: 5000, alertRepeatMs: num(env.LOGIN_ALERT_REPEAT_HOURS, 12) * 3_600_000 }, state);
      state = { ...res.state, runs: res.state.runs.filter((t) => Date.now() - t < 3 * 86_400_000) };
      persist();
      return { outcome: res.outcome, detail: res.detail };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log(`sync crashed: ${detail}`);
      return { outcome: "error", detail };
    } finally {
      await browser?.close().catch(() => undefined); // only disconnects: Chromium keeps running for noVNC
      running = null;
    }
  })();
  return running;
}

// ---------------------------------------------------------------- HTTP
const token = env.WORKER_TOKEN?.trim();
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return send(chrome ? 200 : 503, { ok: !!chrome, running: !!running });
  if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
  if (url.pathname === "/status" && req.method === "GET")
    return send(200, { ...state, runs: undefined, runsToday: runsOnLocalDay(state.runs, Date.now(), tz), maxPerDay: cfg.maxPerDay, running: !!running, leagueUrl, novncUrl, nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null });
  if (url.pathname === "/sync" && req.method === "POST") {
    const p = doSync(true);
    if (url.searchParams.get("wait") === "1") return void p.then((r) => send(200, r));
    // busy / skipped are decided at once: report them; a started run answers 202 and is followed through /status
    const quick = new Promise<null>((r) => setTimeout(() => r(null), 300));
    return void Promise.race([p, quick]).then((r) => (r ? send(200, r) : send(202, { outcome: "started" })));
  }
  send(404, { error: "not found" });
});

let nextRunAt = 0;
async function loop() {
  nextRunAt = Date.now() + 2 * 60_000 + Math.random() * 3 * 60_000; // first run a few minutes after start
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    if (stopping || Date.now() < nextRunAt) continue;
    nextRunAt = Date.now() + jitteredDelayMs(cfg.everyMs, cfg.jitterMs);
    await doSync(false);
  }
}

process.on("SIGTERM", () => {
  stopping = true;
  chrome?.kill();
  server.close();
  process.exit(0);
});

if (!LEAGUE_ID) log("YAHOO_LEAGUE_ID is not set: the browser runs (so you can log in) but no sync will happen");
log(`league page ${leagueUrl}; every ${cfg.everyMs / 3_600_000} h +/- ${cfg.jitterMs / 60_000} min, max ${cfg.maxPerDay}/day`);
server.listen(num(env.WORKER_PORT, 8081), "0.0.0.0", () => log("control server up"));
startChromium();
void loop();
