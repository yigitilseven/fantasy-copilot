"use client";

import { useEffect, useRef } from "react";
import { POSITIONS } from "@/types";
import { useDraftStore, type SortKey } from "@/store/draft-store";
import type { Row } from "./rows";
import { StateBadge } from "./state-badge";
import { StatusPill } from "./status-pill";

const COLS: { key: SortKey; label: string; align?: "r" }[] = [
  { key: "rank", label: "#", align: "r" },
  { key: "name", label: "Player" },
  { key: "team", label: "Tm" },
  { key: "pos", label: "Pos" },
  { key: "nineCat", label: "9-Cat", align: "r" },
  { key: "fit", label: "Fit", align: "r" },
  { key: "vorp", label: "VORP", align: "r" },
  { key: "risk", label: "Risk" },
  { key: "riskAdjusted", label: "R-Adj", align: "r" },
  { key: "adp", label: "ADP", align: "r" },
  { key: "surv", label: "Surv%", align: "r" },
  { key: "state", label: "State" },
];

const RISK_COLOR = { Low: "text-pos", Medium: "text-warn", High: "text-neg" } as const;

export function PlayerTable({ rows, searchRef }: { rows: Row[]; searchRef: React.RefObject<HTMLInputElement | null> }) {
  const s = useDraftStore();
  const selected = Math.min(s.selectedIndex, rows.length - 1);
  const selRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const complete = s.draft?.status === "complete";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <input
          ref={searchRef}
          data-testid="search"
          value={s.search}
          onChange={(e) => s.setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          placeholder="Search (S)"
          className="h-6 w-40 rounded-md border border-rule bg-panel px-2 text-[11px] text-ink outline-none focus:border-brand"
        />
        <div className="flex gap-1">
          {[null, ...POSITIONS].map((p) => (
            <button
              key={p ?? "ALL"}
              onClick={() => s.setPositionFilter(p)}
              className={`h-6 rounded-md px-2 text-[11px] ${s.positionFilter === p ? "bg-brand text-brand-ink" : "bg-raised text-ink-2 hover:bg-track"}`}
            >
              {p ?? "ALL"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-ink-3">{rows.length} available</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="fc-num w-full border-collapse text-[11px]">
          <thead className="sticky top-0 z-10 bg-canvas">
            <tr className="text-left text-ink-3">
              {COLS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => s.setSort(c.key)}
                  className={`cursor-pointer select-none whitespace-nowrap border-b border-rule px-1.5 py-1 font-medium hover:text-ink ${c.align === "r" ? "text-right" : ""}`}
                >
                  {c.label}
                  {s.sortKey === c.key ? (s.sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
              <th className="border-b border-rule px-1.5 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p = r.record.player;
              const isSel = i === selected;
              return (
                <tr
                  key={p.id}
                  ref={isSel ? selRef : undefined}
                  data-testid="player-row"
                  data-player-id={p.id}
                  data-state={r.score.recommendation}
                  data-selected={isSel}
                  onClick={() => s.setSelectedIndex(i)}
                  className={`cursor-pointer border-b border-rule ${isSel ? "bg-raised" : "hover:bg-panel"}`}
                >
                  <td className="px-1.5 py-0.5 text-right text-ink-3">{r.rank}</td>
                  <td className="whitespace-nowrap px-1.5 py-0.5 font-medium text-ink">
                    {p.name}
                    <StatusPill risk={r.record.risk} />
                    {r.record.risk.latestNews?.[0] && (
                      <span data-testid="news-icon" className="ml-1 cursor-help text-[10px]" title={r.record.risk.latestNews[0].title}>📰</span>
                    )}
                  </td>
                  <td className="px-1.5 py-0.5 text-ink-2">{p.nbaTeam}</td>
                  <td className="whitespace-nowrap px-1.5 py-0.5 text-ink-2">{p.positions.join("/")}</td>
                  <td className="px-1.5 py-0.5 text-right">{r.score.nineCat.toFixed(0)}</td>
                  <td className="px-1.5 py-0.5 text-right">{r.score.rosterFit.toFixed(0)}</td>
                  <td className="px-1.5 py-0.5 text-right">{r.score.vorp.toFixed(0)}</td>
                  <td className={`px-1.5 py-0.5 ${RISK_COLOR[r.score.riskLabel]}`}>{r.score.riskLabel}</td>
                  <td className="px-1.5 py-0.5 text-right font-semibold text-ink">{r.score.riskAdjusted.toFixed(1)}</td>
                  <td className="px-1.5 py-0.5 text-right text-ink-2">{r.record.market.yahooAdp.toFixed(1)}</td>
                  <td className="px-1.5 py-0.5 text-right">
                    {r.score.survival == null ? <span className="text-ink-3">–</span> : `${Math.round(r.score.survival * 100)}%`}
                  </td>
                  <td className="px-1.5 py-0.5"><StateBadge state={r.score.recommendation} /></td>
                  <td className="px-1.5 py-0.5 text-right">
                    <button
                      data-testid="draft-button"
                      disabled={s.busy || complete}
                      onClick={(e) => {
                        e.stopPropagation();
                        void s.draftPlayer(p.id);
                      }}
                      className="rounded-md bg-brand-bg px-2 py-px text-[10px] font-semibold text-brand hover:bg-brand hover:text-brand-ink disabled:opacity-40"
                    >
                      DRAFT
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
