"use client";

import { create } from "zustand";
import { useDraftStore } from "./draft-store";
import {
  createPoller,
  fetchYahooLeagues,
  fetchYahooStatus,
  initialPollerState,
  requestSync,
  type Poller,
  type PollerState,
  type YahooLeagueInfo,
} from "./yahoo-sync";

export type YahooConn = "unknown" | "loading" | "unauthenticated" | "authenticated" | "error";

const LEAGUE_KEY = "fdc:yahooLeague";
const readLS = (k: string): string | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLS = (k: string, v: string) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  } catch {}
};

interface YahooStore {
  conn: YahooConn;
  error: string | null;
  leagues: YahooLeagueInfo[];
  leagueKey: string | null;
  liveSync: boolean;
  poller: PollerState;

  loadStatus: () => Promise<void>;
  selectLeague: (key: string | null) => void;
  /** Returns an error message when live sync cannot be enabled. */
  setLiveSync: (on: boolean) => string | null;
  resume: () => void;
  /** Manual fix for an unmapped Yahoo pick: draft the chosen local player at the current pick, then re-sync. */
  resolveUnmapped: (playerId: string) => Promise<void>;
}

let poller: Poller | null = null;
let unsubDraft: (() => void) | null = null;

export const useYahooStore = create<YahooStore>((set, get) => {
  const teardown = () => {
    poller?.stop();
    poller = null;
    unsubDraft?.();
    unsubDraft = null;
  };

  return {
    conn: "unknown",
    error: null,
    leagues: [],
    leagueKey: null,
    liveSync: false,
    poller: initialPollerState(),

    loadStatus: async () => {
      if (get().conn === "loading") return;
      set({ conn: "loading", error: null });
      try {
        const status = await fetchYahooStatus();
        if (!status.authenticated) {
          set({ conn: "unauthenticated" });
          return;
        }
        const leagues = await fetchYahooLeagues().catch((e) => {
          set({ error: e instanceof Error ? e.message : "Could not load Yahoo leagues" });
          return [] as YahooLeagueInfo[];
        });
        const saved = readLS(LEAGUE_KEY);
        const leagueKey = leagues.find((l) => l.leagueKey === saved)?.leagueKey ?? (leagues.length === 1 ? leagues[0].leagueKey : null);
        set({ conn: "authenticated", leagues, leagueKey });
      } catch (e) {
        // Status endpoint unreachable: treat like "not connected" — manual mode is unaffected.
        set({ conn: "unauthenticated", error: e instanceof Error ? e.message : "Yahoo status unavailable" });
      }
    },

    selectLeague: (leagueKey) => {
      if (get().liveSync) get().setLiveSync(false);
      if (leagueKey) writeLS(LEAGUE_KEY, leagueKey);
      set({ leagueKey });
    },

    setLiveSync: (on) => {
      if (!on) {
        teardown();
        set({ liveSync: false, poller: { ...initialPollerState(), lastSyncAt: get().poller.lastSyncAt } });
        return null;
      }
      const { leagueKey, leagues } = get();
      const draft = useDraftStore.getState().draft;
      const league = leagues.find((l) => l.leagueKey === leagueKey);
      if (!league || !draft) return "Pick a Yahoo league first.";
      if (draft.status !== "active") return "The draft is complete.";
      if (league.numTeams && league.numTeams !== draft.teams) return `This draft has ${draft.teams} teams but the league has ${league.numTeams}. Create a draft from the league first.`;
      teardown();
      // Live sync and bot autopick are mutually exclusive.
      const ds = useDraftStore.getState();
      if (ds.mode !== "manual") ds.setMode("manual");
      const draftId = draft.id;
      poller = createPoller({
        run: () => requestSync(draftId, league.leagueKey),
        onIngested: (d) => useDraftStore.getState().applyExternalDraft(d.draft),
        onState: (poller) => set({ poller }),
      });
      unsubDraft = useDraftStore.subscribe((s) => {
        if (s.draft && s.draft.id !== draftId) get().setLiveSync(false);
      });
      set({ liveSync: true, poller: initialPollerState() });
      poller.start();
      return null;
    },

    resume: () => poller?.pollNow(),

    resolveUnmapped: async (playerId) => {
      await useDraftStore.getState().draftPlayer(playerId);
      poller?.pollNow();
    },
  };
});
