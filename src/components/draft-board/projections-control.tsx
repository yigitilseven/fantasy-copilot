"use client";

import { useEffect, useRef, useState } from "react";
import { useDraftStore } from "@/store/draft-store";
import { ago } from "./news-control";

interface ProjStatus {
  count: number;
  matched: number;
  created: number;
  usable: number;
  capturedAt: string | null;
}

/** Top-bar "Projections: Yahoo 2026-27 (412 players, captured 3m ago)" chip; reloads the board when a new capture lands. */
export function ProjectionsControl() {
  const [st, setSt] = useState<ProjStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reloadPlayers = useDraftStore((s) => s.reloadPlayers);
  const seen = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setNow(Date.now());
      try {
        const r = await fetch("/api/projections/yahoo/status", { cache: "no-store" });
        if (r.ok && alive) setSt((await r.json()) as ProjStatus);
      } catch {
        // offline: keep the last status
      }
    };
    const first = setTimeout(() => void tick(), 0);
    const t = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  const capturedAt = st?.capturedAt ?? null;
  useEffect(() => {
    if (!st) return;
    if (seen.current !== undefined && seen.current !== capturedAt) void reloadPlayers();
    seen.current = capturedAt;
  }, [st, capturedAt, reloadPlayers]);

  const yahoo = !!st && st.usable > 0;
  const label = st == null ? "Projections: …" : yahoo ? `Projections: Yahoo 2026-27 (${st.usable} players, captured ${ago(capturedAt, now)})` : "Projections: NBA stats (last season)";
  const tip = yahoo
    ? `Yahoo's own 2026-27 projections drive the valuations (${st!.matched} matched to local players, ${st!.created} added). To refresh: in Yahoo's Players tab pick "2026-27 Proj Stats" and click "Capture projections" in the Draft Copilot overlay.`
    : `Valuations use last season's NBA.com stats. To use Yahoo's 2026-27 projections: open the Yahoo draft room in Safari, Players tab, choose "2026-27 Proj Stats" (turn on "Drafted" to include drafted players), then click "Capture projections" in the Draft Copilot overlay.`;
  return (
    <span
      data-testid="projections-status"
      data-source={yahoo ? "yahoo" : "nba"}
      data-count={st?.usable ?? 0}
      title={tip}
      className={`rounded-md border border-rule bg-raised px-2 py-0.5 text-[11px] ${yahoo ? "text-pos" : "text-ink-2"}`}
    >
      {label}
    </span>
  );
}
