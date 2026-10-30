"use client";

import { create } from "zustand";
import { useDraftStore } from "./draft-store";

export interface PredraftRaw {
  news: { lastSuccessAt: string | null; refreshing?: boolean } | null;
  proj: { usable: number; capturedAt: string | null } | null;
  heartbeat: { receivedAt: number; panel?: "picks" | "hidden" | "n/a" | null } | null;
}

interface PredraftStore extends PredraftRaw {
  /** null = automatic (shown while currentPick === 1); true/false = the user's choice from the chip. */
  override: boolean | null;
  overrideDraftId: number | null;
  now: number;
  refreshing: boolean;
  toggle: (autoVisible: boolean, draftId: number | null) => void;
  load: () => Promise<void>;
  refreshNews: () => Promise<void>;
}

const getJson = async <T,>(url: string): Promise<T | null> => {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
};

export const usePredraftStore = create<PredraftStore>((set, get) => ({
  news: null,
  proj: null,
  heartbeat: null,
  override: null,
  overrideDraftId: null,
  now: Date.now(),
  refreshing: false,

  toggle: (autoVisible, draftId) => {
    const s = get();
    const current = s.overrideDraftId === draftId && s.override !== null ? s.override : autoVisible;
    set({ override: !current, overrideDraftId: draftId });
  },

  load: async () => {
    const id = useDraftStore.getState().draft?.id ?? null;
    const [news, proj, ext] = await Promise.all([
      getJson<{ lastSuccessAt: string | null; refreshing: boolean }>("/api/news/status"),
      getJson<{ usable: number; capturedAt: string | null }>("/api/projections/yahoo/status"),
      id === null ? Promise.resolve(null) : getJson<{ status: { receivedAt: number; panel?: "picks" | "hidden" | "n/a" | null } | null }>(`/api/draft/${id}/external-picks`),
    ]);
    set((s) => ({
      news: news ?? s.news,
      proj: proj ?? s.proj,
      heartbeat: id === null ? null : ext ? (ext.status ?? null) : s.heartbeat,
      now: Date.now(),
    }));
  },

  refreshNews: async () => {
    set({ refreshing: true });
    try {
      await fetch("/api/news/refresh", { method: "POST" });
      await get().load();
      await useDraftStore.getState().reloadPlayers();
    } catch {
      // offline: the row stays red
    } finally {
      set({ refreshing: false });
    }
  },
}));
