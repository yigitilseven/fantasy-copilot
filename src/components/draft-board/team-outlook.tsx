"use client";

import { useEffect, useState } from "react";
import { useDraftStore } from "@/store/draft-store";
import { projectionModeOf, projectionWeightOf } from "@/engine/recommendation/strategy";
import type { OutlookResponse } from "@/server/evaluation";

const VIEW_LABELS: [keyof OutlookResponse["views"], string, string][] = [
  ["proj", "Yahoo 2026-27 proj", "Yahoo's own projected season totals, scored like Yahoo's standings page"],
  ["total", "2025-26 totals", "Real 2025-26 season totals (games played count)"],
  ["avg", "2025-26 averages", "Real 2025-26 per-game averages summed over the roster"],
  ["blend", "Blend", "w x Yahoo + (1 - w) x 2025-26, season totals"],
  ["auto", "Auto (per player)", "Per-player rate/volume blend: rookies, team changes and injury returns lean on the projection, stable veterans on real stats"],
];

/** Your roto rank (of N teams) under each projection view plus the blended rank for every Yahoo weight. */
export function TeamOutlookPanel({ testId = "team-outlook" }: { testId?: string }) {
  const draftId = useDraftStore((s) => s.draft?.id);
  const picks = useDraftStore((s) => s.draft?.picks.length ?? 0);
  const weight = useDraftStore((s) => projectionWeightOf(s.draft?.strategy));
  const auto = useDraftStore((s) => projectionModeOf(s.draft?.strategy) === "auto");
  const [data, setData] = useState<OutlookResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (draftId === undefined) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/draft/${draftId}/evaluation?view=outlook&w=${weight}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as OutlookResponse;
        if (alive) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId, picks, weight, auto]);

  const rankColor = (r: number, n: number) => (r <= 3 ? "text-pos" : r > n - 3 ? "text-neg" : "text-ink");
  return (
    <div data-testid={testId} className="text-[11px]">
      <div className="mb-1 fc-label">Team outlook — your roto rank{data ? ` of ${data.teams}` : ""}</div>
      {err && !data && <div className="text-warn">Could not load ({err})</div>}
      {!data && !err && <div className="text-ink-3">Loading…</div>}
      {data && (
        <>
          <table className="w-full">
            <tbody>
              {VIEW_LABELS.map(([k, label, tip]) => {
                const v = data.views[k];
                return (
                  <tr key={k} title={tip} data-testid={`outlook-${k}`}>
                    <td className={`py-px ${(k === "auto") === auto && (k === "auto" || k === "blend") ? "font-semibold text-brand" : "text-ink-2"}`}>{k === "blend" ? `Fixed blend (${Math.round(data.weight * 100)}% Yahoo)` : label}</td>
                    <td className={`w-10 text-right font-bold fc-num ${v ? rankColor(v.rank, data.teams) : "text-ink-3"}`}>{v ? `#${v.rank}` : "–"}</td>
                    <td className="w-14 text-right fc-num text-ink-3">{v ? `${v.total} pts` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1.5 text-[10px] text-ink-3">Rank by Yahoo weight (fixed) and Auto</div>
          <div data-testid="outlook-sweep" className="mt-0.5 flex gap-1">
            {data.sweep.map((s) => (
              <div key={s.weight} title={`${s.total} rank points`} className={`flex-1 rounded-md bg-raised px-1 py-0.5 text-center ${!auto && Math.abs(s.weight - data.weight) < 1e-9 ? "ring-1 ring-brand" : ""}`}>
                <div className="text-[9px] text-ink-3">{Math.round(s.weight * 100)}%</div>
                <div className={`font-bold fc-num ${rankColor(s.rank, data.teams)}`}>#{s.rank}</div>
              </div>
            ))}
            {data.views.auto && (
              <div data-testid="outlook-sweep-auto" title={`${data.views.auto.total} rank points (per-player rate/volume blend)`} className={`flex-1 rounded-md bg-raised px-1 py-0.5 text-center ${auto ? "ring-1 ring-brand" : ""}`}>
                <div className="text-[9px] text-ink-3">Auto</div>
                <div className={`font-bold fc-num ${rankColor(data.views.auto.rank, data.teams)}`}>#{data.views.auto.rank}</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Top-bar button that opens the outlook as a popover. */
export function TeamOutlookButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        data-testid="outlook-button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Where would your roster finish in Yahoo's roto standings under each projection set?"
        className="rounded-md bg-raised px-2 py-0.5 text-[11px] hover:bg-track"
      >
        Team outlook
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-72 rounded-md border border-rule bg-panel p-2 shadow-lg">
          <TeamOutlookPanel testId="team-outlook-popover" />
        </div>
      )}
    </div>
  );
}
