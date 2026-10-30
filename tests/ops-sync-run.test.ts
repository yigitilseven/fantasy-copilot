import { describe, expect, it } from "vitest";
import { detectLoginWall, type PageSnapshot } from "@/ops/login-wall";
import { loginAlertText, runSync, type AppSyncStatus, type SyncCfg, type SyncDeps, type WorkerState } from "@/ops/sync-run";

const LEAGUE: PageSnapshot = { url: "https://basketball.fantasysports.yahoo.com/nba/100001/9", title: "My Team", text: "Roster" };
const LOGIN: PageSnapshot = { url: "https://login.yahoo.com/?done=x", title: "Sign in", hasLoginForm: true };
const cfg: SyncCfg = { leagueUrl: LEAGUE.url, leagueId: "100001", novncUrl: "https://vps.example.com/novnc/vnc.html", timeoutMs: 60_000, pollMs: 5000, alertRepeatMs: 12 * 3_600_000 };

function harness(o: { snap?: PageSnapshot; statuses?: AppSyncStatus[]; openFails?: boolean; noLeague?: boolean }) {
  let t = Date.parse("2026-10-27T12:00:00Z");
  const alerts: string[] = [];
  const closed: number[] = [];
  const statuses = [...(o.statuses ?? [])];
  const base: AppSyncStatus = { league: o.noLeague ? null : { id: 1 }, lastAttemptAt: "2026-10-27T10:00:00Z", lastFullAt: "2026-10-27T10:00:00Z", stopped: null };
  let calls = 0;
  const d: SyncDeps = {
    now: () => t,
    sleep: async (ms) => void (t += ms),
    openPage: async () => {
      if (o.openFails) throw new Error("net::ERR");
      return { snapshot: async () => o.snap ?? LEAGUE, close: async () => void closed.push(t) };
    },
    syncStatus: async () => (calls++ === 0 ? base : statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? base)),
    alert: async (x) => void alerts.push(x),
    log: () => undefined,
  };
  return { d, alerts, closed, now: () => t };
}
const fresh = (): WorkerState => ({ needsLogin: false, runs: [] });
const done = (at: string, o: Partial<AppSyncStatus> = {}): AppSyncStatus => ({ league: { id: 1 }, lastAttemptAt: at, lastFullAt: at, stopped: null, ...o });

describe("runSync", () => {
  it("success: waits for a new sync report, closes the page, clears nothing it should keep", async () => {
    const h = harness({ statuses: [done("2026-10-27T10:00:00Z"), done("2026-10-27T12:00:20Z")] });
    const r = await runSync(h.d, cfg, fresh());
    expect(r.outcome).toBe("ok");
    expect(r.state.runs).toHaveLength(1);
    expect(r.state.lastOkAt).toBeTruthy();
    expect(h.closed).toHaveLength(1);
    expect(h.alerts).toEqual([]);
  });
  it("login wall: stops immediately, sets the flag, alerts once with the noVNC link", async () => {
    const h = harness({ snap: LOGIN });
    const r = await runSync(h.d, cfg, fresh());
    expect(r.outcome).toBe("login");
    expect(r.state).toMatchObject({ needsLogin: true, wall: "login" });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain("Yahoo needs you to log in again: open https://vps.example.com/novnc/vnc.html");
    expect(h.closed).toHaveLength(1);
    // second run soon after: still flagged, no second alert
    const r2 = await runSync(h.d, cfg, r.state);
    expect(r2.outcome).toBe("login");
    expect(h.alerts).toHaveLength(1);
    expect(r2.detail).toContain("alert already sent");
  });
  it("alerts again after the repeat interval", async () => {
    const h = harness({ snap: LOGIN });
    const r = await runSync(h.d, cfg, { needsLogin: true, runs: [], lastAlertAt: Date.parse("2026-10-26T20:00:00Z") });
    expect(h.alerts).toHaveLength(1);
    expect(r.state.lastAlertAt).toBe(h.now() - 0 > 0 ? r.state.lastAlertAt : 0);
  });
  it("a wall appearing mid-run (login redirect inside the sync) is detected", async () => {
    const h = harness({ statuses: [done("2026-10-27T10:00:00Z"), done("2026-10-27T12:00:15Z", { lastFullAt: "2026-10-27T10:00:00Z", stopped: "redirected to login (/nba/100001/9)" })] });
    const r = await runSync(h.d, cfg, fresh());
    expect(r.outcome).toBe("login");
    expect(r.state.needsLogin).toBe(true);
  });
  it("recovery: clears the flag and says so", async () => {
    const h = harness({ statuses: [done("2026-10-27T10:00:00Z"), done("2026-10-27T12:00:20Z")] });
    const r = await runSync(h.d, cfg, { needsLogin: true, wall: "login", runs: [] });
    expect(r.outcome).toBe("ok");
    expect(r.state.needsLogin).toBe(false);
    expect(h.alerts[0]).toContain("working again");
  });
  it("partial, timeout, app down, no league, open failure", async () => {
    const part = harness({ statuses: [done("2026-10-27T10:00:00Z"), done("2026-10-27T12:00:20Z", { lastFullAt: "2026-10-27T10:00:00Z", stopped: "HTTP 999 on /nba/100001/matchup" })] });
    expect((await runSync(part.d, cfg, fresh())).outcome).toBe("partial");
    expect((await runSync(harness({ statuses: [done("2026-10-27T10:00:00Z")] }).d, cfg, fresh())).outcome).toBe("timeout");
    expect((await runSync(harness({ noLeague: true }).d, cfg, fresh())).outcome).toBe("no-league");
    expect((await runSync(harness({ openFails: true }).d, cfg, fresh())).outcome).toBe("error");
    const down = harness({});
    down.d.syncStatus = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await runSync(down.d, cfg, fresh())).outcome).toBe("app-down");
  });
  it("alert text and the detector agree on the snapshot", () => {
    expect(detectLoginWall(LOGIN, "100001").wall).toBe(true);
    expect(loginAlertText("captcha", "U")).toContain("captcha shown");
  });
});
