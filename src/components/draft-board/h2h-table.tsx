"use client";

import { useEffect, useState } from "react";
import { useDraftStore } from "@/store/draft-store";
import { OPT_VIEWS } from "@/engine/standings-opt/lines";
import type { H2hTableResponse } from "@/server/standings";

/** Weekly H2H round-robin of the current rosters: every team's average matchup win probability vs the other 13 (model: engine/standings-opt/h2h.ts). */
export function H2hTable() {
  const draftId = useDraftStore((s) => s.draft?.id);
  const picks = useDraftStore((s) => s.draft?.picks.length ?? 0);
  const [data, setData] = useState<H2hTableResponse | null>(null);

  useEffect(() => {
    if (draftId === undefined) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/draft/${draftId}/standings?table=1`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as H2hTableResponse;
        if (alive) setData(j);
      } catch {
        // table is optional
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId, picks]);

  if (!data) return null;
  const rows = [...data.rows].sort((a, b) => a.rank - b.rank || b.winProb - a.winProb);
  return (
    <div data-testid="h2h-table" className="text-[11px]">
      <div className="mb-1 fc-label">Weekly H2H round robin — avg win probability vs the other {data.teams - 1} teams</div>
      <table className="w-full fc-num">
        <thead>
          <tr className="text-left text-[10px] text-ink-3">
            <th className="font-normal">#</th><th className="font-normal">Team</th><th className="text-right font-normal">Win</th><th className="text-right font-normal">Cats/wk</th><th className="text-right font-normal">Beats</th>
            {OPT_VIEWS.map((v) => <th key={v} className="text-right font-normal">{data.viewLabels[v]}</th>)}
            <th className="pl-2 font-normal">Core</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.slot} data-testid="h2h-table-row" className={r.isUser ? "bg-brand-bg font-semibold text-brand" : "text-ink"}>
              <td>{r.rank}</td>
              <td>{r.label}</td>
              <td className="text-right">{Math.round(r.winProb * 100)}%</td>
              <td className="text-right">{r.catsWon.toFixed(1)}</td>
              <td className="text-right">{Math.round(r.beats)}/{data.teams - 1}</td>
              {OPT_VIEWS.map((v) => <td key={v} className="text-right text-ink-2">#{r.views[v].rank}</td>)}
              <td className="pl-2 text-ink-2">{r.core.join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
