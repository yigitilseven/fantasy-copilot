import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller, formatAgo, requestSync, type SyncOutcome } from "@/store/yahoo-sync";
import type { DraftState } from "@/types";

const draft = (picks: number, status: DraftState["status"] = "active"): DraftState => ({ id: 1, teams: 14, userSlot: 13, rounds: 13, currentPick: picks + 1, status, picks: [] });
const ok = (ingested: number, status: DraftState["status"] = "active"): SyncOutcome => ({ ok: true, data: { ingested, draft: draft(ingested, status), unmapped: [] } });
const fail = (code: string): SyncOutcome => ({ ok: false, code, message: `${code} happened` });

function setup(outcomes: SyncOutcome[] | ((n: number) => SyncOutcome)) {
  let n = 0;
  const run = vi.fn(async () => (typeof outcomes === "function" ? outcomes(n++) : outcomes[Math.min(n++, outcomes.length - 1)]));
  const onIngested = vi.fn();
  const p = createPoller({ run, onIngested });
  return { run, onIngested, p };
}

describe("sync poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls every 2.5s and only refreshes the draft when picks were ingested", async () => {
    const { run, onIngested, p } = setup([ok(0), ok(2), ok(0)]);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onIngested).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2499);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onIngested).toHaveBeenCalledTimes(1);
    expect(p.getState().totalIngested).toBe(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onIngested).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("never overlaps requests: next poll is scheduled after the previous settles", async () => {
    let resolve!: (o: SyncOutcome) => void;
    const run = vi.fn(() => new Promise<SyncOutcome>((r) => (resolve = r)));
    const p = createPoller({ run, onIngested: vi.fn() });
    p.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1);
    resolve(ok(0));
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("records freshness on success", async () => {
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const { p } = setup([ok(0)]);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState().lastSyncAt).toBe(Date.parse("2026-10-07T12:00:00Z"));
    p.stop();
  });

  it("backs off to 10s on RATE_LIMIT / NETWORK, flags delayed, recovers to 2.5s", async () => {
    const { run, p } = setup([fail("RATE_LIMIT"), fail("NETWORK"), ok(0), ok(0)]);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState()).toMatchObject({ delayed: true, delayMs: 10_000, consecutiveFailures: 1, phase: "running" });
    await vi.advanceTimersByTimeAsync(9999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(p.getState().consecutiveFailures).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(p.getState()).toMatchObject({ delayed: false, consecutiveFailures: 0, delayMs: 2500, lastError: null });
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it("auto-pauses after 3 consecutive failures; pollNow resumes", async () => {
    const { run, p } = setup((n) => (n < 3 ? fail("NETWORK") : ok(1)));
    p.start();
    await vi.advanceTimersByTimeAsync(0 + 10_000 + 10_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(p.getState()).toMatchObject({ phase: "paused", consecutiveFailures: 3, lastError: { code: "NETWORK" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3); // no more polling while paused
    p.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(4);
    expect(p.getState()).toMatchObject({ phase: "running", consecutiveFailures: 0 });
    p.stop();
  });

  it("a success in between resets the failure count", async () => {
    const { p } = setup([fail("NETWORK"), fail("NETWORK"), ok(0), fail("NETWORK"), fail("NETWORK")]);
    p.start();
    await vi.advanceTimersByTimeAsync(10_000 + 10_000 + 2500 + 10_000 + 1);
    expect(p.getState()).toMatchObject({ phase: "running", consecutiveFailures: 2 });
    p.stop();
  });

  it("AUTH pauses immediately", async () => {
    const { p } = setup([fail("AUTH")]);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState()).toMatchObject({ phase: "paused", delayed: false });
  });

  it("UNMAPPED_PLAYER is surfaced without counting as a failure; partial ingest is applied; clears when fixed", async () => {
    const unmapped: SyncOutcome = { ok: false, code: "UNMAPPED_PLAYER", message: "x", data: { ingested: 1, draft: draft(1), unmapped: [{ pick: 2, yahooPlayerKey: "466.p.9", name: "Mystery Man" }] } };
    const { run, onIngested, p } = setup([unmapped, unmapped, unmapped, unmapped, ok(0)]);
    p.start();
    await vi.advanceTimersByTimeAsync(2500 * 3);
    expect(run).toHaveBeenCalledTimes(4);
    expect(p.getState()).toMatchObject({ phase: "running", consecutiveFailures: 0, unmapped: { pick: 2, name: "Mystery Man" } });
    expect(onIngested).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2500);
    expect(p.getState().unmapped).toBeNull();
    p.stop();
  });

  it("stops when the draft completes and after stop()", async () => {
    const { run, p } = setup([ok(1), ok(1, "complete"), ok(0)]);
    p.start();
    await vi.advanceTimersByTimeAsync(2500 + 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(p.getState().phase).toBe("complete");
    const b = setup([ok(0)]);
    b.p.start();
    await vi.advanceTimersByTimeAsync(0);
    b.p.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(b.p.getState().phase).toBe("idle");
  });

  it("a stopped in-flight request is discarded", async () => {
    let resolve!: (o: SyncOutcome) => void;
    const onIngested = vi.fn();
    const p = createPoller({ run: () => new Promise<SyncOutcome>((r) => (resolve = r)), onIngested });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    resolve(ok(3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onIngested).not.toHaveBeenCalled();
  });

  it("a throwing run is treated as NETWORK", async () => {
    const p = createPoller({ run: async () => { throw new Error("boom"); }, onIngested: vi.fn() });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState()).toMatchObject({ delayed: true, lastError: { code: "NETWORK", message: "boom" } });
    p.stop();
  });
});

describe("requestSync / formatAgo", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("maps transport failure to NETWORK and Yahoo 502 codes through", async () => {
    expect(await requestSync(1, "L", (async () => { throw new Error("offline"); }) as never)).toMatchObject({ ok: false, code: "NETWORK" });
    expect(await requestSync(1, "L", (async () => res(502, { error: "slow down", code: "RATE_LIMIT" })) as never)).toMatchObject({ ok: false, code: "RATE_LIMIT", message: "slow down" });
    const good = await requestSync(1, "L", (async () => res(200, { ingested: 2, draft: draft(2), unmapped: [] })) as never);
    expect(good).toMatchObject({ ok: true, data: { ingested: 2 } });
    const um = await requestSync(1, "L", (async () => res(502, { code: "UNMAPPED_PLAYER", error: "e", ingested: 1, draft: draft(1), unmapped: [{ pick: 2, yahooPlayerKey: "k", name: "N" }] })) as never);
    expect(um).toMatchObject({ ok: false, code: "UNMAPPED_PLAYER", data: { ingested: 1, unmapped: [{ name: "N" }] } });
  });
  it("formats freshness", () => {
    expect(formatAgo(null, 1000)).toBe("not synced yet");
    expect(formatAgo(0, 2000)).toBe("synced 2s ago");
    expect(formatAgo(0, 125_000)).toBe("synced 2m ago");
  });
});
