import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_POLL_MS, browserLabel, createBrowserPoller, fetchBrowserStatus, type BrowserOutcome, type BrowserStatus } from "@/store/browser-sync";
import type { DraftState } from "@/types";

const draft = (n: number): DraftState => ({ id: 1, teams: 4, userSlot: 1, rounds: 3, currentPick: n + 1, status: "active", picks: [] });
const status = (receivedAt: number): BrowserStatus => ({ receivedAt, lastIngestAt: receivedAt, received: 3, highestPick: 3, totalIngested: 3, unmapped: null, mismatches: [], stoppedReason: null, conflict: null });

describe("browser sync label", () => {
  it("off / waiting / live / quiet", () => {
    expect(browserLabel(false, null, 0)).toEqual({ label: "Browser sync: off", tone: "off" });
    expect(browserLabel(true, null, 0).tone).toBe("waiting");
    expect(browserLabel(true, status(10_000), 13_000)).toEqual({ label: "Browser: live · 3s ago", tone: "live" });
    expect(browserLabel(true, status(0), 45_000)).toEqual({ label: "Browser: quiet · 45s", tone: "stale" });
    expect(browserLabel(true, status(0), 125_000).label).toBe("Browser: quiet · 2m");
  });
});

describe("browser poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls every 2s, reports data, recovers from errors, and stops", async () => {
    const outcomes: BrowserOutcome[] = [
      { ok: true, data: { draft: draft(1), status: status(1) } },
      { ok: false, message: "down" },
      { ok: true, data: { draft: draft(2), status: status(2) } },
    ];
    let i = 0;
    const data: number[] = [];
    const errors: (string | null)[] = [];
    const p = createBrowserPoller({ draftId: 1, run: async () => outcomes[Math.min(i++, outcomes.length - 1)], onData: (d) => data.push(d.draft.currentPick), onError: (e) => errors.push(e) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(data).toEqual([2]);
    await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS);
    expect(errors.at(-1)).toBe("down");
    await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS);
    expect(data).toEqual([2, 3]);
    expect(errors.at(-1)).toBeNull();
    p.stop();
    const calls = i;
    await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 5);
    expect(i).toBe(calls);
  });

  it("fetchBrowserStatus never throws", async () => {
    expect(await fetchBrowserStatus(1, (async () => { throw new Error("boom"); }) as unknown as typeof fetch)).toEqual({ ok: false, message: "boom" });
    expect(await fetchBrowserStatus(1, (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch)).toMatchObject({ ok: false });
  });
});
