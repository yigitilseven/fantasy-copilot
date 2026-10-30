"use client";

/*
 * One data source for every Copilot screen (Today, Moves, Matchup, League, Settings). Loaded once in the (copilot) layout:
 *  - overview  GET /api/season            lineup, week, moves, alerts, news, freshness (refreshed every 60 s)
 *  - sync      GET /api/season/sync-status Yahoo sync parts and ages
 *  - brief     GET /api/season/claude-brief (falls back to the engine text)
 *  - report / trades: loaded on first use (League, Moves)
 * Actions: refreshAll (Yahoo sync on the server + news), markMove ("I did this"), setAddsUsed, saveSettings.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SeasonOverview } from "@/server/season";
import type { SyncStatus } from "@/server/season-ingest";
import type { SeasonReport } from "@/engine/season/report";
import type { MoveSuggestion } from "@/engine/season/addDrop";
import type { TradeIdea } from "@/engine/season/trades";
import type { SeasonSettings } from "@/engine/season/types";

export interface StoredBrief { day: string; text: string; usedClaude: boolean; note?: string; at: string }
export interface BriefState {
  text: string; usedClaude: boolean; at: string | null; note?: string; weekly: boolean;
  /** Your roster changed after it was written: its moves may already be done (the server rewrites it shortly). */
  outdated: boolean;
}
export interface ApiError { message: string; code?: string }

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((body as { error?: string }).error ?? `Request failed (${res.status})`) as Error & { code?: string };
    e.code = (body as { code?: string }).code;
    throw e;
  }
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface Lazy<T> { data: T | null; error: string | null; loading: boolean }

interface SeasonCtx {
  date: string;
  setDate: (d: string) => void;
  data: SeasonOverview | null;
  error: ApiError | null;
  sync: SyncStatus | null;
  brief: BriefState | null;
  report: Lazy<SeasonReport>;
  trades: Lazy<{ ideas: TradeIdea[]; evaluated: number }>;
  loadReport: () => void;
  loadTrades: () => void;
  reload: () => void;
  /** Progress text while a refresh runs; null otherwise. */
  busy: string | null;
  /** Outcome of the last refresh (kept until dismissed). */
  notice: string | null;
  dismissNotice: () => void;
  refreshAll: () => Promise<void>;
  markMove: (m: MoveSuggestion) => Promise<void>;
  setAddsUsed: (n: number | null) => Promise<void>;
  saveSettings: (patch: Partial<SeasonSettings>) => Promise<void>;
}

const Ctx = createContext<SeasonCtx | null>(null);

export function useSeason(): SeasonCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSeason outside SeasonProvider");
  return c;
}
/** League report, loaded on first use. */
export function useReport(): Lazy<SeasonReport> {
  const s = useSeason();
  const { loadReport } = s;
  useEffect(() => loadReport(), [loadReport]);
  return s.report;
}
/** Trade ideas, loaded on first use. */
export function useTrades(): SeasonCtx["trades"] {
  const s = useSeason();
  const { loadTrades } = s;
  useEffect(() => loadTrades(), [loadTrades]);
  return s.trades;
}

const idle = <T,>(): Lazy<T> => ({ data: null, error: null, loading: false });

export function SeasonProvider({ children }: { children: React.ReactNode }) {
  const [date, setDate] = useState("");
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<SeasonOverview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [brief, setBrief] = useState<BriefState | null>(null);
  const [report, setReport] = useState<Lazy<SeasonReport>>(idle);
  const [trades, setTrades] = useState<SeasonCtx["trades"]>(idle);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const want = useRef({ report: false, trades: false });
  const q = date ? `?date=${date}` : "";

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const run = () => {
      api<SeasonOverview>(`/api/season${q}`)
        .then((o) => {
          if (!alive) return;
          setData(o);
          setError(null);
        })
        .catch((e) => alive && setError({ message: (e as Error).message, code: (e as { code?: string }).code }));
      api<SyncStatus>("/api/season/sync-status").then((x) => alive && setSync(x)).catch(() => undefined);
    };
    run();
    const t = setInterval(run, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [q, tick]);

  // The brief can be rewritten during the day (after your roster changes): check every 2 minutes.
  useEffect(() => {
    let alive = true;
    const load = () => api<{ brief: (StoredBrief & { kind?: string }) | null; outdated?: boolean }>("/api/season/claude-brief")
      .then(async (r) => {
        if (!alive) return;
        if (r.brief) {
          const weekly = r.brief.kind ? r.brief.kind === "weekly-plan" : /^STANDING:/m.test(r.brief.text);
          setBrief({ text: r.brief.text, usedClaude: r.brief.usedClaude, at: r.brief.at, note: r.brief.note, weekly, outdated: !!r.outdated });
          return;
        }
        const t = await fetch("/api/season/brief?format=text", { cache: "no-store" }).then((x) => (x.ok ? x.text() : "")).catch(() => "");
        if (alive) setBrief(t ? { text: t, usedClaude: false, at: null, weekly: false, outdated: false } : null);
      })
      .catch(() => alive && setBrief(null));
    load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tick]);

  // Report / trades: (re)loaded when a screen asked for them, and on every reload.
  const fetchReport = useCallback(() => {
    setReport((r) => ({ ...r, loading: true }));
    api<SeasonReport>(`/api/season/report${q}`)
      .then((d) => setReport({ data: d, error: null, loading: false }))
      .catch((e) => setReport({ data: null, error: (e as Error).message, loading: false }));
  }, [q]);
  const fetchTrades = useCallback(() => {
    setTrades((r) => ({ ...r, loading: true }));
    api<{ ideas: TradeIdea[]; evaluated: number }>(`/api/season/trades${q}`)
      .then((d) => setTrades({ data: d, error: null, loading: false }))
      .catch((e) => setTrades({ data: null, error: (e as Error).message, loading: false }));
  }, [q]);
  const loadReport = useCallback(() => {
    if (want.current.report) return;
    want.current.report = true;
    fetchReport();
  }, [fetchReport]);
  const loadTrades = useCallback(() => {
    if (want.current.trades) return;
    want.current.trades = true;
    fetchTrades();
  }, [fetchTrades]);
  useEffect(() => {
    if (want.current.report) fetchReport();
    if (want.current.trades) fetchTrades();
  }, [tick, fetchReport, fetchTrades]);

  // Full Yahoo sync on the server's browser + news/schedule, then reload.
  const refreshAll = useCallback(async () => {
    setBusy("Starting Yahoo sync…");
    setNotice(null);
    try {
      const before = await api<SyncStatus>("/api/season/sync-status").then((s) => s.lastAttemptAt).catch(() => null);
      const [start] = await Promise.all([
        api<{ outcome: string; detail?: string }>("/api/season/sync-now", { method: "POST" }),
        api("/api/season/refresh", { method: "POST" }).catch(() => undefined),
      ]);
      if (start.outcome === "started" || start.outcome === "busy") {
        const t0 = Date.now();
        for (;;) {
          setBusy(`Syncing Yahoo… ${Math.round((Date.now() - t0) / 1000)}s`);
          await new Promise((r) => setTimeout(r, 5000));
          const s = await api<SyncStatus>("/api/season/sync-status").catch(() => null);
          if (s?.lastAttemptAt && s.lastAttemptAt !== before) break;
          if (Date.now() - t0 > 8 * 60_000) throw new Error("The Yahoo sync is taking longer than 8 minutes; the data updates when it finishes.");
        }
        setNotice("Synced with Yahoo: rosters, matchup, free agents and transactions are current.");
      } else if (start.outcome !== "ok") {
        setNotice(start.outcome === "skipped" ? `Yahoo sync not started (${start.detail ?? "skipped"}). News and schedule were refreshed.` : `${start.detail ?? `Yahoo sync: ${start.outcome}`} News and schedule were refreshed.`);
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  }, [reload]);

  const markMove = useCallback(async (m: MoveSuggestion) => {
    await api("/api/season/roster", json("PATCH", { add: m.add.playerId, drop: m.drop?.playerId, il: m.ilMove?.playerId }));
    reload();
  }, [reload]);
  const setAddsUsed = useCallback(async (n: number | null) => {
    await api("/api/season/settings", json("PUT", { addsUsed: n }));
    reload();
  }, [reload]);
  const saveSettings = useCallback(async (patch: Partial<SeasonSettings>) => {
    await api("/api/season/settings", json("PUT", { settings: patch }));
    reload();
  }, [reload]);

  const value = useMemo<SeasonCtx>(() => ({
    date, setDate, data, error, sync, brief, report, trades, loadReport, loadTrades, reload, busy, notice,
    dismissNotice: () => setNotice(null), refreshAll, markMove, setAddsUsed, saveSettings,
  }), [date, data, error, sync, brief, report, trades, loadReport, loadTrades, reload, busy, notice, refreshAll, markMove, setAddsUsed, saveSettings]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
