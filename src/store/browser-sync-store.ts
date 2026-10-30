"use client";

import { create } from "zustand";
import { useDraftStore } from "./draft-store";
import { createBrowserPoller, type BrowserPoller, type BrowserStatus } from "./browser-sync";

const KEY = "fdc:browserSync";
const readLS = (): boolean => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const writeLS = (on: boolean) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
};

interface BrowserSyncStore {
  /** Follow picks delivered by the Yahoo userscript. Locks "Mock vs bots" like Yahoo live sync. */
  enabled: boolean;
  status: BrowserStatus | null;
  error: string | null;
  setEnabled: (on: boolean) => void;
  /** (Re)starts polling for the given draft when enabled; called when the active draft changes. */
  attach: (draftId: number | null) => void;
  /** Manual fix for an unmapped name: draft the chosen player at the current pick, then poll again. */
  resolveUnmapped: (playerId: string) => Promise<void>;
}

let poller: BrowserPoller | null = null;
let pollerDraft: number | null = null;
let restored = false;

export const useBrowserSyncStore = create<BrowserSyncStore>((set, get) => ({
  enabled: false,
  status: null,
  error: null,

  setEnabled: (on) => {
    writeLS(on);
    set({ enabled: on });
    if (on) {
      // Browser sync and bot autopick are mutually exclusive.
      const ds = useDraftStore.getState();
      if (ds.mode !== "manual") ds.setMode("manual");
    }
    get().attach(useDraftStore.getState().draft?.id ?? null);
  },

  attach: (draftId) => {
    if (!restored && draftId !== null) {
      // First attach after load: restore the persisted choice.
      restored = true;
      if (readLS()) {
        set({ enabled: true });
        const ds = useDraftStore.getState();
        if (ds.mode !== "manual") ds.setMode("manual");
      }
    }
    const { enabled } = get();
    if (!enabled || draftId === null) {
      poller?.stop();
      poller = null;
      pollerDraft = null;
      if (!enabled) set({ status: null, error: null });
      return;
    }
    if (poller && pollerDraft === draftId) return;
    poller?.stop();
    pollerDraft = draftId;
    set({ status: null });
    poller = createBrowserPoller({
      draftId,
      onData: (d) => {
        set({ status: d.status });
        useDraftStore.getState().applyExternalDraft(d.draft);
      },
      onError: (error) => set({ error }),
    });
    poller.start();
  },

  resolveUnmapped: async (playerId) => {
    await useDraftStore.getState().draftPlayer(playerId);
    poller?.pollNow();
  },
}));
