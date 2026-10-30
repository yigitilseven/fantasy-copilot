"use client";

import { create } from "zustand";
import { leagueConfig } from "@/config/default-league";
import {
  buildSimPlayers,
  buildSurvivalInput,
  computeValuations,
  scorePlayers,
} from "@/engine";
import { SimulationClient } from "@/workers/simulation-client";
import { applyStrategyPatch, defaultStrategy, objectiveModeOf, projectionSpecOf, robustnessModeOf, robustnessOf, strategyKey, valuationOptionsOf, type StrategyPatch } from "@/engine/recommendation/strategy";
import { applyProjectionBlend, projectionDisagreement } from "@/engine/projection/blend";
import { sourceZ, type SourceZ } from "@/engine/projection/disagreement";
import type { StandingsResponse } from "@/server/recommendations";
import type {
  DraftState,
  PlayerRecord,
  PlayerScore,
  PlayerValuation,
  Position,
  Strategy,
} from "@/types";
import { deriveDraft, simSeed } from "./derived";

export type SimStatus = "idle" | "running" | "error";
export type SortKey =
  | "rank" | "name" | "team" | "pos" | "nineCat" | "fit" | "vorp" | "risk"
  | "riskAdjusted" | "adp" | "surv" | "state";

export type DraftMode = "manual" | "mock";
export type BotSpeed = "instant" | "fast" | "slow";
/** Delay (ms) before bots act, per speed setting. */
export const BOT_DELAY_MS: Record<BotSpeed, number> = { instant: 0, fast: 600, slow: 2000 };

const modeKey = (id: number) => `fdc:mode:${id}`;
const SPEED_KEY = "fdc:botSpeed";

function readLS(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {}
}
const loadMode = (id: number): DraftMode => (readLS(modeKey(id)) === "mock" ? "mock" : "manual");
const loadSpeed = (): BotSpeed => {
  const v = readLS(SPEED_KEY);
  return v === "instant" || v === "slow" || v === "fast" ? v : "fast";
};

export interface NewDraftConfig {
  userSlot: number;
  teams: number;
  rounds: number;
}

interface DraftStore {
  mode: DraftMode;
  botSpeed: BotSpeed;
  /** Bots stay quiet (mock mode) until the user drafts or presses "Sim to my pick". */
  botsPaused: boolean;
  loaded: boolean;
  loading: boolean;
  /** Records as served (Yahoo/2025-26 components attached, no blend); `records` below is the blended view in use. */
  rawRecords: PlayerRecord[];
  /** Blended with the draft's strategy.projectionWeight. */
  records: PlayerRecord[];
  recordById: Record<string, PlayerRecord>;
  /** |z_yahoo - z_actual| per player; only computed while strategy.robustness > 0. */
  disagreement: Record<string, number> | null;
  /** z vectors of the projection side vs the real stats per player; only computed in the "auto" robustness mode (round-aware). */
  sources: Record<string, SourceZ> | null;
  valuations: Record<string, PlayerValuation>;
  /** Standings analysis of the current state (candidate gains + projected finish), fetched from /api/draft/[id]/standings. */
  standings: StandingsResponse | null;
  draft: DraftState | null;
  survival: { targetPick: number; map: Record<string, number> } | null;
  simStatus: SimStatus;
  simInfo: { simulations: number; elapsedMs: number } | null;
  scores: PlayerScore[];
  selectedIndex: number;
  search: string;
  positionFilter: Position | null;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  busy: boolean;
  lastError: string | null;

  init: () => Promise<void>;
  newDraft: () => Promise<void>;
  newMockDraft: (cfg: NewDraftConfig) => Promise<void>;
  /** Create a fresh draft with the given shape (e.g. from a Yahoo league); manual mode. */
  newLeagueDraft: (cfg: NewDraftConfig) => Promise<void>;
  /** Adopt a DraftState produced elsewhere (Yahoo sync). Ignored unless it is the same draft and strictly newer. */
  applyExternalDraft: (draft: DraftState) => boolean;
  /** Change the draft strategy (optimistic; PATCH /api/draft/[id]/strategy). Recomputes the table immediately. */
  setStrategy: (patch: StrategyPatch) => Promise<void>;
  /** Pull the draft from the server (GET) and adopt newer picks / a strategy changed elsewhere (e.g. the Yahoo overlay). */
  refreshDraft: () => Promise<void>;
  /** Re-fetch the player records (e.g. after a news/injury update changed statuses) and recompute the board. */
  reloadPlayers: () => Promise<void>;
  setMode: (m: DraftMode) => void;
  setBotSpeed: (v: BotSpeed) => void;
  /** Run bot picks. `step` = a single pick (used for the rolling animation at non-instant speeds). */
  runBots: (step?: boolean) => Promise<void>;
  simToMyPick: () => Promise<void>;
  draftPlayer: (playerId: string) => Promise<void>;
  undo: () => Promise<void>;
  recompute: () => void;
  setSelectedIndex: (i: number) => void;
  setSearch: (s: string) => void;
  setPositionFilter: (p: Position | null) => void;
  setSort: (k: SortKey) => void;
  dismissError: () => void;
}

class ApiError extends Error {}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {}
    throw new ApiError(msg);
  }
  return (await res.json()) as T;
}

/** Fitted opponent model enabled in /history (null = defaults). Refreshed at most once a minute; any failure keeps the defaults. */
let activeModel: { k: number; autopickShare: number } | undefined;
let activeModelAt = 0;
async function currentOpponentModel(): Promise<{ k: number; autopickShare: number } | undefined> {
  if (Date.now() - activeModelAt < 60_000) return activeModel;
  activeModelAt = Date.now();
  try {
    const m = await api<{ active?: { k?: unknown; autopickShare?: unknown } | null }>("/api/history/model");
    const a = m?.active;
    activeModel = a && typeof a.k === "number" && typeof a.autopickShare === "number" && a.k > 0 ? { k: a.k, autopickShare: a.autopickShare } : undefined;
  } catch {
    activeModel = undefined;
  }
  return activeModel;
}

const post = (url: string, body?: unknown) =>
  api<DraftState>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Blends the raw records with the strategy's projection weight and derives everything that depends on the lines. */
let appliedBlendKey = "";
const blendKeyOf = (s?: Strategy | null) => `${projectionSpecOf(s)}|${robustnessModeOf(s)}|${robustnessOf(s)}|${objectiveModeOf(s) === "classic"}`;
function derivedRecords(raw: PlayerRecord[], strategy?: Strategy | null) {
  appliedBlendKey = blendKeyOf(strategy);
  const records = applyProjectionBlend(raw, projectionSpecOf(strategy));
  return {
    records,
    recordById: Object.fromEntries(records.map((r) => [r.player.id, r])),
    valuations: computeValuations(records, valuationOptionsOf(strategy)).valuations,
    disagreement: robustnessModeOf(strategy) === "always" ? projectionDisagreement(raw) : null,
    sources: robustnessModeOf(strategy) === "auto" ? sourceZ(raw) : null,
  };
}
/** True when the two strategies need different projection lines / valuations. */
const projectionChanged = (a?: Strategy | null, b?: Strategy | null) => projectionSpecOf(a) !== projectionSpecOf(b);
const robustnessChanged = (a?: Strategy | null, b?: Strategy | null) => robustnessModeOf(a) !== robustnessModeOf(b) || robustnessOf(a) !== robustnessOf(b) || (objectiveModeOf(a) === "classic") !== (objectiveModeOf(b) === "classic");

let simClient: SimulationClient | null = null;
let initPromise: Promise<void> | null = null;
let simToken = 0;
/** Bumped on every local strategy change so an older in-flight refresh cannot overwrite it. */
let strategySeq = 0;

export { simSeed };

export const useDraftStore = create<DraftStore>((set, get) => {
  /** Score with the current survival (null when absent/stale). */
  const computeScores = (): PlayerScore[] => {
    const { draft, records, valuations, survival, disagreement, sources, standings } = get();
    const d = deriveDraft(draft);
    if (!draft || !d || d.complete) return [];
    // The standings analysis only applies to the state it was computed for (same pick, same objective).
    const roto = standings && standings.currentPick === d.currentPick && standings.draftId === draft.id && standings.objective === objectiveModeOf(draft.strategy) ? standings.analysis : null;
    const surv = survival && survival.targetPick === d.survivalTarget ? survival.map : null;
    return scorePlayers({
      records,
      valuations,
      draftedIds: d.draftedIds,
      userRosterIds: d.userRosterIds,
      currentPick: d.currentPick,
      config: { teams: draft.teams },
      rounds: draft.rounds,
      strategy: draft.strategy,
      disagreement: disagreement ?? undefined,
      sources: sources ?? undefined,
      userNextPick: d.isUserOnClock ? d.survivalTarget : d.userNextPick,
      isUserOnClock: d.isUserOnClock,
      survival: surv,
      roto: roto ?? undefined,
    });
  };

  let standingsToken = 0;
  /** Fetches the standings analysis for the current state (server-side: same engine and seed as the overlay), then rescoring. */
  const kickStandings = async () => {
    const { draft } = get();
    const token = ++standingsToken;
    if (!draft) return;
    try {
      const st = await api<StandingsResponse>(`/api/draft/${draft.id}/standings`, { cache: "no-store" });
      if (token !== standingsToken) return;
      set({ standings: st });
      get().recompute();
    } catch {
      if (token === standingsToken) set({ standings: null });
    }
  };

  const kickSimulation = async () => {
    const { draft, records, valuations } = get();
    const d = deriveDraft(draft);
    const token = ++simToken;
    if (!draft || !d || d.complete) {
      set({ simStatus: "idle", simInfo: null });
      return;
    }
    const model = await currentOpponentModel();
    if (token !== simToken) return;
    const drafted = new Set(d.draftedIds);
    const players = buildSimPlayers(
      records
        .filter((r) => !drafted.has(r.player.id))
        .map((r) => ({
          id: r.player.id,
          adp: r.market.yahooAdp,
          adpStdDev: r.market.adpStdDev,
          value: valuations[r.player.id]?.nineCat ?? 0,
          positions: r.player.positions,
        })),
    );
    const built = buildSurvivalInput({
      currentPick: d.currentPick,
      teams: draft.teams,
      userSlot: draft.userSlot,
      rounds: draft.rounds,
      players,
      simulations: leagueConfig.simulations,
      seed: simSeed(draft.id, d.currentPick),
      model,
    });
    if (!built) {
      set({ simStatus: "idle", simInfo: null });
      return;
    }
    set({ simStatus: "running" });
    try {
      simClient ??= new SimulationClient();
      const result = await simClient.run(built.input);
      if (token !== simToken) return;
      set({
        survival: { targetPick: built.targetPick, map: result.survival },
        simStatus: "idle",
        simInfo: { simulations: result.simulations, elapsedMs: result.elapsedMs },
      });
      get().recompute();
    } catch (e) {
      if (token !== simToken || (e instanceof Error && e.message === "superseded")) return;
      set({
        survival: null,
        simStatus: "error",
        simInfo: null,
        lastError: "Simulation failed — showing raw rankings (no survival odds).",
      });
      get().recompute();
    }
  };

  /** After a draft change: immediate rescore without survival, then simulate. */
  const afterDraftChange = (draft: DraftState) => {
    // A different draft can carry a different projection mix: re-blend before scoring.
    set({ draft, survival: null, selectedIndex: 0, ...(blendKeyOf(draft.strategy) !== appliedBlendKey && get().rawRecords.length ? derivedRecords(get().rawRecords, draft.strategy) : {}) });
    get().recompute();
    void kickSimulation();
    void kickStandings();
  };

  const mutate = async (fn: () => Promise<DraftState>): Promise<boolean> => {
    if (get().busy) return false;
    set({ busy: true, lastError: null });
    try {
      afterDraftChange(await fn());
      return true;
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : "Unexpected error" });
      return false;
    } finally {
      set({ busy: false });
    }
  };

  return {
    mode: "manual",
    botSpeed: "fast",
    botsPaused: false,
    loaded: false,
    loading: false,
    rawRecords: [],
    records: [],
    recordById: {},
    disagreement: null,
    sources: null,
    valuations: {},
    standings: null,
    draft: null,
    survival: null,
    simStatus: "idle",
    simInfo: null,
    scores: [],
    selectedIndex: 0,
    search: "",
    positionFilter: null,
    sortKey: "riskAdjusted",
    sortDir: "desc",
    busy: false,
    lastError: null,

    init: () => {
      initPromise ??= (async () => {
        set({ loading: true, lastError: null });
        try {
          const rawRecords = await api<PlayerRecord[]>("/api/players");
          let draft: DraftState;
          try {
            draft = await api<DraftState>("/api/draft");
          } catch {
            draft = await post("/api/draft", {});
          }
          set({ rawRecords, ...derivedRecords(rawRecords, draft.strategy), loaded: true });
          set({ mode: loadMode(draft.id), botSpeed: loadSpeed(), botsPaused: false });
          afterDraftChange(draft);
        } catch (e) {
          initPromise = null; // allow retry
          set({ lastError: e instanceof Error ? e.message : "Failed to load" });
        } finally {
          set({ loading: false });
        }
      })();
      return initPromise;
    },

    newDraft: async () => {
      let created: DraftState | null = null;
      const ok = await mutate(async () => (created = await post("/api/draft", {})));
      if (ok && created) {
        writeLS(modeKey((created as DraftState).id), "manual");
        set({ mode: "manual", botsPaused: false });
      }
    },

    newMockDraft: async (cfg) => {
      let created: DraftState | null = null;
      const teams = Math.min(16, Math.max(8, Math.round(cfg.teams)));
      const body = {
        teams,
        userSlot: Math.min(teams, Math.max(1, Math.round(cfg.userSlot))),
        rounds: Math.max(1, Math.round(cfg.rounds)),
      };
      const ok = await mutate(async () => (created = await post("/api/draft", body)));
      if (ok && created) {
        writeLS(modeKey((created as DraftState).id), "mock");
        set({ mode: "mock", botsPaused: false });
      }
    },

    newLeagueDraft: async (cfg) => {
      let created: DraftState | null = null;
      const ok = await mutate(async () => (created = await post("/api/draft", { teams: cfg.teams, userSlot: cfg.userSlot, rounds: cfg.rounds })));
      if (ok && created) {
        writeLS(modeKey((created as DraftState).id), "manual");
        set({ mode: "manual", botsPaused: false });
      }
    },

    applyExternalDraft: (draft) => {
      const cur = get().draft;
      if (!cur || cur.id !== draft.id) return false;
      if (draft.picks.length <= cur.picks.length) {
        // Same picks: still adopt a strategy changed elsewhere (overlay) without resetting selection / survival.
        if (draft.strategy && strategyKey(draft.strategy) !== strategyKey(cur.strategy)) {
          const reblend = projectionChanged(draft.strategy, cur.strategy) || robustnessChanged(draft.strategy, cur.strategy);
          set({ draft: { ...cur, strategy: draft.strategy }, ...(reblend ? derivedRecords(get().rawRecords, draft.strategy) : {}) });
          get().recompute();
          if (reblend) void kickSimulation();
          void kickStandings();
        }
        return false;
      }
      afterDraftChange(draft);
      return true;
    },

    setStrategy: async (patch) => {
      const cur = get().draft;
      if (!cur) return;
      const prev = cur.strategy ?? defaultStrategy();
      const seq = ++strategySeq;
      const optimistic = applyStrategyPatch(prev, patch);
      const reblend = projectionChanged(optimistic, prev) || robustnessChanged(optimistic, prev);
      set({ draft: { ...cur, strategy: optimistic }, lastError: null, ...(reblend ? derivedRecords(get().rawRecords, optimistic) : {}) });
      get().recompute();
      if (projectionChanged(optimistic, prev)) void kickSimulation(); // survival uses the valuations as the opponents' tiebreaker
      try {
        const saved = await api<DraftState>(`/api/draft/${cur.id}/strategy`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (seq !== strategySeq) return;
        const now = get().draft;
        if (now && now.id === saved.id && saved.strategy) {
          const again = strategyKey(saved.strategy) !== strategyKey(now.strategy);
          set({ draft: { ...now, strategy: saved.strategy }, ...(again ? derivedRecords(get().rawRecords, saved.strategy) : {}) });
          get().recompute();
        }
        void kickStandings(); // the objective / mix may change the candidate gains (the server has the saved strategy now)
      } catch (e) {
        if (seq !== strategySeq) return;
        const now = get().draft;
        if (now) set({ draft: { ...now, strategy: prev }, ...derivedRecords(get().rawRecords, prev) });
        set({ lastError: e instanceof Error ? e.message : "Could not save strategy" });
        get().recompute();
      }
    },

    refreshDraft: async () => {
      const cur = get().draft;
      if (!cur || get().busy) return;
      const seq = strategySeq;
      try {
        const fresh = await api<DraftState>(`/api/draft/${cur.id}`, { cache: "no-store" });
        if (seq !== strategySeq || get().busy || get().draft?.id !== fresh.id) return;
        get().applyExternalDraft(fresh);
      } catch {
        // transient; next tick retries
      }
    },

    reloadPlayers: async () => {
      try {
        const rawRecords = await api<PlayerRecord[]>("/api/players", { cache: "no-store" });
        set({ rawRecords, ...derivedRecords(rawRecords, get().draft?.strategy) });
        get().recompute();
      } catch {
        // transient; keep the current records
      }
    },

    setMode: (mode) => {
      const d = get().draft;
      if (d) writeLS(modeKey(d.id), mode);
      set({ mode, botsPaused: false });
    },

    setBotSpeed: (botSpeed) => {
      writeLS(SPEED_KEY, botSpeed);
      set({ botSpeed });
    },

    runBots: async (step) => {
      const d = get().draft;
      if (!d || d.status === "complete") return;
      const ok = await mutate(() =>
        post(`/api/draft/${d.id}/autopick`, step ? { untilUserTurn: false, count: 1 } : { untilUserTurn: true }),
      );
      if (!ok) set({ botsPaused: true }); // avoid a retry loop; user can press "Sim to my pick"
    },

    simToMyPick: async () => {
      set({ botsPaused: false });
      await get().runBots();
    },

    draftPlayer: async (playerId) => {
      const d = get().draft;
      if (!d || d.status === "complete") return;
      // Mock mode: only the user's own turn can be entered by hand.
      if (get().mode === "mock" && !deriveDraft(d)?.isUserOnClock) return;
      const ok = await mutate(() => post(`/api/draft/${d.id}/pick`, { playerId, source: "manual" }));
      if (ok) set({ botsPaused: false });
    },

    undo: async () => {
      const d = get().draft;
      if (!d || d.picks.length === 0) return;
      if (get().mode === "mock") {
        // Roll back to (and including) the user's previous pick; with none, roll back to the start.
        const mine = d.picks.filter((p) => p.teamSlot === d.userSlot);
        const toPick = mine.length ? mine[mine.length - 1].pick : 1;
        const ok = await mutate(() => post(`/api/draft/${d.id}/undo`, { toPick }));
        if (ok) set({ botsPaused: true });
        return;
      }
      await mutate(() => post(`/api/draft/${d.id}/undo`));
    },

    recompute: () => set({ scores: computeScores() }),
    setSelectedIndex: (i) => set({ selectedIndex: Math.max(0, i) }),
    setSearch: (search) => set({ search, selectedIndex: 0 }),
    setPositionFilter: (positionFilter) => set({ positionFilter, selectedIndex: 0 }),
    setSort: (k) =>
      set((s) => ({
        sortKey: k,
        sortDir: s.sortKey === k ? (s.sortDir === "asc" ? "desc" : "asc") : k === "name" || k === "team" || k === "pos" || k === "adp" || k === "rank" || k === "state" ? "asc" : "desc",
        selectedIndex: 0,
      })),
    dismissError: () => set({ lastError: null }),
  };
});
