import type { DraftState } from "@/types";

/** Client-side logic for "Browser sync" (picks pushed by the Yahoo draft room userscript). No React/Zustand: unit-testable with fake timers. */

export const BROWSER_POLL_MS = 2000;
/** Older than this without a delivery (the userscript heartbeats every 15 s) = the Yahoo tab is gone/paused. */
export const BROWSER_STALE_MS = 30_000;

export interface BrowserStatus {
  receivedAt: number;
  lastIngestAt: number | null;
  received: number;
  highestPick: number;
  totalIngested: number;
  unmapped: { pick: number; name: string; reason: "unmatched" | "ambiguous"; candidates?: string[] } | null;
  mismatches: { pick: number; ours: string; seen: string }[];
  stoppedReason: "gap" | "conflict" | "draft_complete" | null;
  conflict: { pick: number; name: string; alreadyAtPick: number } | null;
  /** From the userscript (null/undefined = old script). */
  panel?: "picks" | "hidden" | "n/a" | null;
  pageVisible?: boolean | null;
}

export interface BrowserPollData {
  draft: DraftState;
  status: BrowserStatus | null;
}

export type BrowserOutcome = { ok: true; data: BrowserPollData } | { ok: false; message: string };

export async function fetchBrowserStatus(draftId: number, fetchImpl: typeof fetch = fetch): Promise<BrowserOutcome> {
  try {
    const res = await fetchImpl(`/api/draft/${draftId}/external-picks`, { cache: "no-store" });
    if (!res.ok) return { ok: false, message: `Browser sync status failed (${res.status})` };
    return { ok: true, data: (await res.json()) as BrowserPollData };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Network error" };
  }
}

export interface BrowserPoller {
  start(): void;
  stop(): void;
  pollNow(): void;
}

/** Sequential poller: GET status+draft every 2 s; never throws; transient failures just retry. */
export function createBrowserPoller(opts: {
  draftId: number;
  run?: (draftId: number) => Promise<BrowserOutcome>;
  onData: (d: BrowserPollData) => void;
  onError: (message: string | null) => void;
  intervalMs?: number;
}): BrowserPoller {
  const run = opts.run ?? ((id: number) => fetchBrowserStatus(id));
  const interval = opts.intervalMs ?? BROWSER_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const tick = async (gen: number) => {
    timer = null;
    let out: BrowserOutcome;
    try {
      out = await run(opts.draftId);
    } catch (e) {
      out = { ok: false, message: e instanceof Error ? e.message : "Network error" };
    }
    if (gen !== generation) return;
    if (out.ok) {
      opts.onError(null);
      opts.onData(out.data);
    } else opts.onError(out.message);
    timer = setTimeout(() => void tick(gen), interval);
  };
  const begin = () => {
    generation++;
    if (timer) clearTimeout(timer);
    void tick(generation);
  };
  return {
    start: begin,
    pollNow: begin,
    stop() {
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type BrowserTone = "off" | "waiting" | "live" | "stale";

/** Chip text/tone: "Browser: live · 3s ago" (fresh) / "Browser: quiet · 45s" (no delivery for 30 s+). */
export function browserLabel(enabled: boolean, status: BrowserStatus | null, nowMs: number): { label: string; tone: BrowserTone } {
  if (!enabled) return { label: "Browser sync: off", tone: "off" };
  if (!status) return { label: "Browser: waiting for Yahoo page", tone: "waiting" };
  const ageMs = Math.max(0, nowMs - status.receivedAt);
  const age = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m` : `${Math.floor(ageMs / 3_600_000)}h`;
  return ageMs > BROWSER_STALE_MS ? { label: `Browser: quiet · ${age}`, tone: "stale" } : { label: `Browser: live · ${age} ago`, tone: "live" };
}

/** No delivery for longer than this while the draft is live = "Yahoo tab not reporting" banner (the script heartbeats every 5 s). */
export const BROWSER_QUIET_WARN_MS = 15_000;
/** ... and red after this. */
export const BROWSER_QUIET_RED_MS = 45_000;

export type YahooAlert =
  | { kind: "none" }
  | { kind: "quiet"; level: "amber" | "red"; ageMs: number; message: string }
  | { kind: "panel"; message: string }
  | { kind: "page-hidden"; message: string };

export const QUIET_MESSAGE = "Yahoo tab not reporting — keep the Yahoo draft window visible (Safari pauses background tabs)";
export const PANEL_MESSAGE = "Yahoo: Picks panel hidden — switch the side panel to PICKS";

/**
 * Banner logic for the app. Only while Browser sync is on and the draft is active. Silence beats everything (we cannot even
 * hear the panel report); then the userscript's own report: page hidden / Picks panel hidden. `sinceMs` = how long sync has
 * been on without any delivery (used when nothing has ever been received).
 */
export function yahooAlert(opts: { enabled: boolean; draftActive: boolean; status: BrowserStatus | null; now: number; sinceMs?: number }): YahooAlert {
  const { enabled, draftActive, status, now } = opts;
  if (!enabled || !draftActive) return { kind: "none" };
  const age = status ? Math.max(0, now - status.receivedAt) : (opts.sinceMs ?? 0);
  if (age > BROWSER_QUIET_WARN_MS) return { kind: "quiet", level: age > BROWSER_QUIET_RED_MS ? "red" : "amber", ageMs: age, message: QUIET_MESSAGE };
  if (status?.pageVisible === false) return { kind: "page-hidden", message: "Yahoo tab is in the background — bring the Yahoo draft window to the front (Safari pauses background tabs)" };
  if (status?.panel === "hidden") return { kind: "panel", message: PANEL_MESSAGE };
  return { kind: "none" };
}
