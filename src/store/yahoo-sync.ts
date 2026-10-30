import type { DraftState } from "@/types";

/** Client-side Yahoo live-sync logic. No React/Zustand imports so it can be unit-tested with fake timers. */

export const SYNC_INTERVAL_MS = 2500;
export const SYNC_BACKOFF_MS = 10_000;
export const SYNC_MAX_FAILURES = 3;

export interface YahooStatus {
  authenticated: boolean;
  credentialsConfigured?: boolean;
  tokensPresent?: boolean;
}

export interface YahooLeagueInfo {
  leagueKey: string;
  name: string;
  numTeams: number | null;
  draftStatus: string | null;
  userSlot: number | null;
  season?: number | null;
}

export interface UnmappedPick {
  pick: number;
  yahooPlayerKey: string;
  name?: string | null;
}

export interface SyncData {
  ingested: number;
  draft: DraftState;
  unmapped: UnmappedPick[];
  stoppedReason?: string | null;
}

export type SyncOutcome = { ok: true; data: SyncData } | { ok: false; code: string; message: string; data?: Partial<SyncData> };

type FetchLike = typeof fetch;

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchYahooStatus(fetchImpl: FetchLike = fetch): Promise<YahooStatus> {
  const res = await fetchImpl("/api/yahoo/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`Yahoo status failed (${res.status})`);
  const b = (await res.json()) as Partial<YahooStatus>;
  return { ...b, authenticated: b.authenticated ?? Boolean(b.credentialsConfigured && b.tokensPresent) };
}

export async function fetchYahooLeagues(fetchImpl: FetchLike = fetch): Promise<YahooLeagueInfo[]> {
  const res = await fetchImpl("/api/yahoo/leagues", { cache: "no-store" });
  const b = await readBody(res);
  if (!res.ok) throw new Error(typeof b.error === "string" ? b.error : `Yahoo leagues failed (${res.status})`);
  return ((b.leagues as YahooLeagueInfo[] | undefined) ?? []).map((l) => ({ ...l, numTeams: l.numTeams ?? null, userSlot: l.userSlot ?? null, draftStatus: l.draftStatus ?? null }));
}

/** One POST /api/yahoo/sync. Never throws: failures become `{ ok: false, code }` (NETWORK for transport errors). */
export async function requestSync(draftId: number, leagueKey: string, fetchImpl: FetchLike = fetch): Promise<SyncOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/yahoo/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId, leagueKey }) });
  } catch (e) {
    return { ok: false, code: "NETWORK", message: e instanceof Error ? e.message : "Network error" };
  }
  const b = await readBody(res);
  if (res.ok) return { ok: true, data: { ...(b as unknown as SyncData), ingested: Number(b.ingested ?? 0), unmapped: (b.unmapped as UnmappedPick[] | undefined) ?? [] } };
  return {
    ok: false,
    code: typeof b.code === "string" ? b.code : res.status >= 500 ? "NETWORK" : "UNKNOWN",
    message: typeof b.error === "string" ? b.error : `Sync failed (${res.status})`,
    data: b.draft ? (b as unknown as Partial<SyncData>) : undefined,
  };
}

// ------------------------------------------------------------------ poller

export type PollPhase = "idle" | "running" | "paused" | "complete";

export interface PollerState {
  phase: PollPhase;
  consecutiveFailures: number;
  /** Delay before the next poll (ms). */
  delayMs: number;
  /** Epoch ms of the last successful round trip to Yahoo (unmapped players count: Yahoo answered). */
  lastSyncAt: number | null;
  lastError: { code: string; message: string } | null;
  /** True while backing off after RATE_LIMIT / NETWORK. */
  delayed: boolean;
  unmapped: UnmappedPick | null;
  totalIngested: number;
}

export const initialPollerState = (): PollerState => ({
  phase: "idle",
  consecutiveFailures: 0,
  delayMs: SYNC_INTERVAL_MS,
  lastSyncAt: null,
  lastError: null,
  delayed: false,
  unmapped: null,
  totalIngested: 0,
});

export interface PollerOptions {
  /** One sync round trip (see requestSync). Must not throw; a throw is treated as NETWORK. */
  run: () => Promise<SyncOutcome>;
  /** Called with fresh state whenever picks were ingested (refresh draft → recompute → simulation). */
  onIngested: (data: Partial<SyncData> & { draft: DraftState }) => void;
  onState?: (s: PollerState) => void;
  now?: () => number;
  intervalMs?: number;
  backoffMs?: number;
  maxFailures?: number;
}

const BACKOFF_CODES = new Set(["RATE_LIMIT", "NETWORK"]);
const FATAL_CODES = new Set(["AUTH"]);

export interface Poller {
  start(): void;
  stop(): void;
  /** Poll right away (e.g. after the user resolved an unmapped player). Resumes a paused poller. */
  pollNow(): void;
  getState(): PollerState;
}

/**
 * Sequential poller: one request in flight, next poll scheduled after it settles.
 *  - success: reset failures, interval 2.5 s; draft refreshed only when ingested > 0
 *  - UNMAPPED_PLAYER: not a failure (Yahoo is fine) — surfaces the pick, keeps polling at the normal interval
 *  - RATE_LIMIT / NETWORK: back off to 10 s and flag `delayed`
 *  - 3 consecutive failures (or AUTH): paused until pollNow()/start()
 *  - draft complete: stops
 */
export function createPoller(opts: PollerOptions): Poller {
  const interval = opts.intervalMs ?? SYNC_INTERVAL_MS;
  const backoff = opts.backoffMs ?? SYNC_BACKOFF_MS;
  const maxFailures = opts.maxFailures ?? SYNC_MAX_FAILURES;
  const now = opts.now ?? Date.now;
  let state = initialPollerState();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let inFlight = false;

  const emit = (patch: Partial<PollerState>) => {
    state = { ...state, ...patch };
    opts.onState?.(state);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number, gen: number) => {
    clear();
    timer = setTimeout(() => void tick(gen), ms);
  };

  async function tick(gen: number) {
    timer = null;
    if (gen !== generation || inFlight) return;
    inFlight = true;
    let out: SyncOutcome;
    try {
      out = await opts.run();
    } catch (e) {
      out = { ok: false, code: "NETWORK", message: e instanceof Error ? e.message : "Network error" };
    }
    if (gen !== generation) return; // stopped/restarted meanwhile (that call owns inFlight now)
    inFlight = false;

    const partial = out.ok ? out.data : out.data;
    if (partial?.draft && (partial.ingested ?? 0) > 0) {
      emit({ totalIngested: state.totalIngested + (partial.ingested ?? 0) });
      opts.onIngested(partial as Partial<SyncData> & { draft: DraftState });
    }

    if (out.ok) {
      const complete = out.data.draft?.status === "complete" || out.data.stoppedReason === "draft_complete";
      emit({ consecutiveFailures: 0, lastError: null, delayed: false, unmapped: null, lastSyncAt: now(), delayMs: interval, phase: complete ? "complete" : "running" });
      if (!complete) schedule(interval, gen);
      return;
    }
    if (out.code === "UNMAPPED_PLAYER") {
      emit({ consecutiveFailures: 0, lastError: null, delayed: false, unmapped: out.data?.unmapped?.[0] ?? { pick: 0, yahooPlayerKey: "?" }, lastSyncAt: now(), delayMs: interval, phase: "running" });
      schedule(interval, gen);
      return;
    }
    if (out.code === "DRAFT_COMPLETE") {
      emit({ phase: "complete", lastError: null, delayed: false });
      return;
    }
    const failures = state.consecutiveFailures + 1;
    const delayed = BACKOFF_CODES.has(out.code);
    const pause = failures >= maxFailures || FATAL_CODES.has(out.code);
    emit({ consecutiveFailures: failures, lastError: { code: out.code, message: out.message }, delayed, delayMs: delayed ? backoff : interval, phase: pause ? "paused" : "running" });
    if (!pause) schedule(delayed ? backoff : interval, gen);
  }

  const begin = () => {
    generation++;
    clear();
    inFlight = false;
    emit({ phase: "running", consecutiveFailures: 0, lastError: null, delayed: false, delayMs: interval });
    void tick(generation);
  };

  return {
    start: begin,
    pollNow: begin,
    stop() {
      generation++;
      clear();
      inFlight = false;
      emit({ ...initialPollerState(), lastSyncAt: state.lastSyncAt, totalIngested: state.totalIngested });
    },
    getState: () => state,
  };
}

// ------------------------------------------------------------------ display helpers

/** "synced 2s ago" style freshness. */
export function formatAgo(lastSyncAt: number | null, nowMs: number): string {
  if (lastSyncAt === null) return "not synced yet";
  const s = Math.max(0, Math.round((nowMs - lastSyncAt) / 1000));
  if (s < 60) return `synced ${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `synced ${m}m ago` : `synced ${Math.floor(m / 60)}h ago`;
}
