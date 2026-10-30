import { detectLoginWall, WALL_LABEL, type PageSnapshot, type WallKind } from "./login-wall";

/** One sync cycle of the browser worker, with every side effect injected (so it is testable without a browser). */
export interface SyncPage {
  snapshot(): Promise<PageSnapshot>;
  close(): Promise<void>;
}
export interface AppSyncStatus { league: unknown; lastAttemptAt: string | null; lastFullAt: string | null; stopped: string | null }
export interface SyncDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Opens the league page with the userscript injected and waits for load. */
  openPage(url: string): Promise<SyncPage>;
  syncStatus(): Promise<AppSyncStatus>;
  alert(text: string): Promise<void>;
  log(line: string): void;
}
export interface SyncCfg {
  leagueUrl: string;
  leagueId: string;
  novncUrl: string;
  timeoutMs: number;
  pollMs: number;
  /** minimum time between two "please log in" alerts */
  alertRepeatMs: number;
}
export interface WorkerState {
  needsLogin: boolean;
  wall?: WallKind;
  lastAlertAt?: number;
  lastRunAt?: number;
  lastOutcome?: string;
  lastOkAt?: number;
  runs: number[];
}
export type SyncOutcome = "ok" | "partial" | "login" | "no-league" | "app-down" | "timeout" | "error";
export interface SyncResult { outcome: SyncOutcome; detail?: string; state: WorkerState }

export function loginAlertText(kind: WallKind, novncUrl: string): string {
  return `Yahoo needs you to log in again: open ${novncUrl}\n(${WALL_LABEL[kind]}. Log in by hand in that browser window; the next sync run picks it up. Nothing is typed for you.)`;
}

export async function runSync(deps: SyncDeps, cfg: SyncCfg, st: WorkerState): Promise<SyncResult> {
  const state: WorkerState = { ...st, runs: [...st.runs, deps.now()], lastRunAt: deps.now() };
  const finish = (outcome: SyncOutcome, detail?: string): SyncResult => {
    state.lastOutcome = detail ? `${outcome}: ${detail}` : outcome;
    deps.log(`sync ${state.lastOutcome}`);
    return { outcome, detail, state };
  };
  let before: AppSyncStatus;
  try {
    before = await deps.syncStatus();
  } catch (e) {
    return finish("app-down", e instanceof Error ? e.message : String(e));
  }
  if (!before.league) return finish("no-league", "the app has no season league yet (run season:init, or copy data/fantasy.sqlite)");
  const startedAt = deps.now();
  const prevAttempt = before.lastAttemptAt ? Date.parse(before.lastAttemptAt) : 0;

  let page: SyncPage;
  try {
    page = await deps.openPage(cfg.leagueUrl);
  } catch (e) {
    return finish("error", `could not open the league page: ${e instanceof Error ? e.message : e}`);
  }
  const wallCheck = async () => detectLoginWall(await page.snapshot(), cfg.leagueId);
  const raise = async (kind: WallKind, reason?: string) => {
    state.needsLogin = true;
    state.wall = kind;
    const repeat = !state.lastAlertAt || deps.now() - state.lastAlertAt >= cfg.alertRepeatMs;
    if (repeat) {
      state.lastAlertAt = deps.now();
      await deps.alert(loginAlertText(kind, cfg.novncUrl)).catch((e) => deps.log(`alert failed: ${e}`));
    }
    return finish("login", `${kind}${reason ? ` (${reason})` : ""}${repeat ? "" : " [alert already sent]"}`);
  };
  try {
    const first = await wallCheck();
    if (first.wall) return await raise(first.kind!, first.reason);

    const deadline = deps.now() + cfg.timeoutMs;
    while (deps.now() < deadline) {
      await deps.sleep(cfg.pollMs);
      const w = await wallCheck().catch(() => ({ wall: false }) as ReturnType<typeof detectLoginWall>);
      if (w.wall) return await raise(w.kind!, w.reason);
      let s: AppSyncStatus;
      try {
        s = await deps.syncStatus();
      } catch {
        continue; // transient; the deadline decides
      }
      const attempt = s.lastAttemptAt ? Date.parse(s.lastAttemptAt) : 0;
      if (attempt > Math.max(prevAttempt, startedAt - 1000)) {
        const full = s.lastFullAt ? Date.parse(s.lastFullAt) : 0;
        const wasDown = state.needsLogin;
        if (s.stopped && /login|sign/i.test(s.stopped)) return await raise("login", s.stopped);
        state.needsLogin = false;
        state.wall = undefined;
        if (full >= startedAt - 1000) {
          state.lastOkAt = deps.now();
          if (wasDown) await deps.alert("Yahoo login is working again; league sync resumed.").catch(() => undefined);
          return finish("ok");
        }
        return finish("partial", s.stopped ?? "sync did not finish all parts");
      }
    }
    return finish("timeout", `no sync report within ${Math.round(cfg.timeoutMs / 1000)}s`);
  } catch (e) {
    return finish("error", e instanceof Error ? e.message : String(e));
  } finally {
    await page.close().catch(() => undefined);
  }
}
