"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDraftStore } from "@/store/draft-store";

interface NewsStatus {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  stale: boolean;
  refreshing: boolean;
  sources: { id: string; ok: boolean; lastError: string | null; lastSuccessAt: string | null }[];
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** Top-bar "News: updated 2h ago" chip with a refresh button; tooltip lists per-source errors. */
export function NewsControl() {
  const [st, setSt] = useState<NewsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/news/status", { cache: "no-store" });
      if (r.ok) setSt((await r.json()) as NewsStatus);
    } catch {
      // offline: keep the last status
    }
  }, []);

  // A refresh started by the server (auto, > 6 h) lands while the page is open: pick up the new statuses.
  const reloadPlayers = useDraftStore((s) => s.reloadPlayers);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      void load();
    };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);
  const lastSuccess = st?.lastSuccessAt ?? null;
  useEffect(() => {
    if (!lastSuccess) return;
    if (seen.current && seen.current !== lastSuccess) void reloadPlayers();
    seen.current = lastSuccess;
  }, [lastSuccess, reloadPlayers]);

  const refresh = async () => {
    setBusy(true);
    try {
      await fetch("/api/news/refresh", { method: "POST" });
      await load();
      await reloadPlayers();
    } finally {
      setBusy(false);
    }
  };

  const failed = (st?.sources ?? []).filter((x) => !x.ok);
  const label = st == null ? "News: …" : st.lastSuccessAt ? `News: updated ${ago(st.lastSuccessAt, now)}` : "News: not updated";
  const tone = st == null ? "text-ink-3" : !st.lastSuccessAt || st.stale ? "text-warn" : failed.length ? "text-warn" : "text-ink-2";
  const tip = failed.length ? failed.map((x) => `${x.id}: ${x.lastError}`).join("\n") : "All sources ok. Injury reports + headlines refresh automatically every 6 h.";
  return (
    <div className="flex items-center gap-1" data-testid="news-control">
      <span data-testid="news-status" title={tip} className={`rounded-md border border-rule bg-raised px-2 py-0.5 text-[11px] ${tone}`}>
        {label}
        {failed.length > 0 && ` · ${failed.length} failed`}
      </span>
      <button
        data-testid="news-refresh"
        aria-label="Refresh news"
        title="Refresh injuries and news now"
        disabled={busy || st?.refreshing}
        onClick={() => void refresh()}
        className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] hover:bg-track disabled:opacity-40"
      >
        {busy || st?.refreshing ? "…" : "↻"}
      </button>
    </div>
  );
}
