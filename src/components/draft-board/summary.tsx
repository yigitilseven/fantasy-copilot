"use client";

import { useMemo } from "react";
import { estimateStandings } from "@/engine";
import { CATEGORIES } from "@/types";
import { useDraftStore } from "@/store/draft-store";
import { ZBar } from "@/components/categories/category-profile";
import { TeamOutlookPanel } from "./team-outlook";
import { H2hTable } from "./h2h-table";

export function DraftSummary() {
  const draft = useDraftStore((s) => s.draft);
  const recordById = useDraftStore((s) => s.recordById);
  const valuations = useDraftStore((s) => s.valuations);
  const est = useMemo(
    () => (draft ? estimateStandings(draft.picks, draft.teams, draft.userSlot, valuations) : null),
    [draft, valuations],
  );
  if (!draft || !est) return null;
  const mine = draft.picks.filter((p) => p.teamSlot === draft.userSlot);
  const myTotals = est.totals[draft.userSlot];
  const rankColor = (r: number) => (r <= 3 ? "text-pos" : r > draft.teams - 3 ? "text-neg" : "text-ink");
  const h2h = [...est.h2h].sort((a, b) => b.won - a.won);

  return (
    <div data-testid="draft-complete" className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
      <div className="mb-3 flex items-baseline gap-3">
        <div className="text-xl font-bold text-pos">DRAFT COMPLETE</div>
        <div className="text-ink-2">
          Projected H2H category win rate:{" "}
          <span data-testid="win-rate" className="font-bold text-ink">{Math.round(est.winRate * 100)}%</span>
          <span className="ml-2 text-ink-3">(z-score totals, no schedule or injuries)</span>
        </div>
      </div>
      <div data-testid="draft-summary" className="grid grid-cols-3 gap-6">
        <section>
          <h3 className="mb-1 fc-label">My roster</h3>
          <ol>
            {mine.map((p, i) => {
              const r = recordById[p.playerId];
              return (
                <li key={p.pick} data-testid="summary-roster-item" className="flex items-baseline gap-1.5 py-px">
                  <span className="w-4 text-right text-ink-3">{i + 1}</span>
                  <span className="truncate font-medium text-ink">{r?.player.name ?? p.playerId}</span>
                  <span className="ml-auto whitespace-nowrap text-ink-3">{r?.player.positions.join("/")}</span>
                  <span className="w-8 text-right text-ink-3">#{p.pick}</span>
                </li>
              );
            })}
          </ol>
        </section>
        <section>
          <h3 className="mb-1 fc-label">Category rank (of {draft.teams})</h3>
          {CATEGORIES.map((c) => (
            <div key={c} data-testid={`rank-${c}`} className="flex items-center gap-1.5 py-px">
              <span className="w-8 text-ink-2">{c}</span>
              <ZBar value={myTotals[c]} max={Math.max(4, ...Object.values(est.totals).map((t) => Math.abs(t[c])))} />
              <span className="w-10 text-right fc-num text-ink-2">{myTotals[c].toFixed(1)}</span>
              <span className={`w-8 text-right font-bold fc-num ${rankColor(est.ranks[c])}`}>#{est.ranks[c]}</span>
            </div>
          ))}
        </section>
        <section>
          <h3 className="mb-1 fc-label">Projected H2H vs each team (cats won)</h3>
          {h2h.map((h) => (
            <div key={h.slot} data-testid="h2h-row" className="flex items-center gap-1.5 py-px">
              <span className="w-8 text-ink-2">T{h.slot}</span>
              <div className="flex h-2 flex-1 overflow-hidden bg-panel">
                <div className="bg-pos" style={{ width: `${(h.won / 9) * 100}%` }} />
                <div className="bg-ink-3" style={{ width: `${(h.tied / 9) * 100}%` }} />
                <div className="bg-neg" style={{ width: `${(h.lost / 9) * 100}%` }} />
              </div>
              <span className="w-14 text-right fc-num text-ink">{h.won}-{h.lost}{h.tied ? `-${h.tied}` : ""}</span>
            </div>
          ))}
        </section>
      </div>
      <div className="mt-4 grid grid-cols-[minmax(0,24rem)_minmax(0,1fr)] gap-6">
        <section>
          <TeamOutlookPanel />
        </section>
        <section>
          <H2hTable />
        </section>
      </div>
    </div>
  );
}
