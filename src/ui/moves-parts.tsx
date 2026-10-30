"use client";

import { useState } from "react";
import { cx } from "./kit";

export type MoveSort = "score" | "dWeek" | "dRos";
export const SORT_LABEL: Record<MoveSort, string> = { score: "Value", dWeek: "This week", dRos: "Rest of season" };

/** The "Value ⌄" menu from the design. */
export function SortMenu<T extends string>({ value, labels, onChange }: { value: T; labels: Record<T, string>; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="min-h-9 rounded-lg bg-raised px-3 text-[14px] font-medium text-ink">
        {labels[value]} <span aria-hidden>⌄</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 min-w-40 rounded-xl border border-rule bg-panel p-1 shadow-lg">
          {(Object.keys(labels) as T[]).map((k) => (
            <button key={k} role="menuitemradio" aria-checked={k === value} onClick={() => { onChange(k); setOpen(false); }} className={cx("block w-full rounded-lg px-3 py-2 text-left text-[14px]", k === value ? "bg-brand-bg text-brand" : "text-ink hover:bg-raised")}>
              {labels[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface CatEffect { cat: string; v: number; horizon: string }
/** Parses engine reasons ("this week: PTS +12.5pp, REB +8.0pp", "costs TO −2.4pp") into gains and costs; the rest stays as plain notes. */
export function parseReasons(reasons: string[]): { gains: CatEffect[]; costs: CatEffect[]; notes: string[] } {
  const gains: CatEffect[] = [], costs: CatEffect[] = [], notes: string[] = [];
  const item = /^(\S+)\s+([+\-−]?[\d.]+)\s*pp$/;
  for (const r of reasons) {
    const m = /^(this week|rest of season|costs):\s*(.*)$/.exec(r) ?? /^(costs)\s+(.*)$/.exec(r);
    if (!m) { notes.push(r); continue; }
    const parts = m[2].split(",").map((x) => item.exec(x.trim()));
    if (parts.some((x) => !x)) { notes.push(r); continue; }
    for (const x of parts) {
      const v = parseFloat(x![2].replace("−", "-"));
      (m[1] === "costs" ? costs : gains).push({ cat: x![1], v: m[1] === "costs" ? -Math.abs(v) : v, horizon: m[1] });
    }
  }
  return { gains, costs, notes };
}
