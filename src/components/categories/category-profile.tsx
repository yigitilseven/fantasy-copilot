"use client";

import { useMemo } from "react";
import { categoryProfile, effectiveNeedWeights } from "@/engine";
import { CATEGORIES, type PlayerValuation, type Strategy } from "@/types";

/** Diverging bar: value in [-max, max] drawn from the centre line. */
export function ZBar({ value, max = 2 }: { value: number; max?: number }) {
  const pct = Math.min(1, Math.abs(value) / max) * 50;
  return (
    <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-track">
      <div className="absolute inset-y-0 left-1/2 w-px bg-ink-3" />
      <div
        className={`absolute inset-y-0 ${value >= 0 ? "bg-pos" : "bg-neg"}`}
        style={value >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </div>
  );
}

export function CategoryProfile({
  rosterIds,
  valuations,
  strategy,
}: {
  rosterIds: string[];
  valuations: Record<string, PlayerValuation>;
  strategy?: Strategy;
}) {
  const { avg, need } = useMemo(() => {
    const profile = categoryProfile(rosterIds, valuations);
    const n = rosterIds.length;
    const need = effectiveNeedWeights(profile, n, strategy);
    const avg = Object.fromEntries(CATEGORIES.map((c) => [c, n ? profile[c] / n : 0])) as Record<string, number>;
    return { avg, need };
  }, [rosterIds, valuations, strategy]);

  return (
    <div data-testid="category-profile" className="px-3 py-2">
      <div className="mb-1 flex justify-between fc-label">
        <span>Category profile (avg z)</span>
        <span>need</span>
      </div>
      {CATEGORIES.map((c) => {
        const punted = (strategy?.categoryEmphasis[c] ?? 1) <= 0;
        return (
        <div
          key={c}
          data-testid={`cat-${c}`}
          data-punted={punted ? "true" : undefined}
          title={punted ? `${c} is punted in your strategy` : undefined}
          className={`flex items-center gap-1.5 py-px text-[11px] ${punted ? "opacity-35" : ""}`}
        >
          <span className={`w-8 text-ink-2 ${punted ? "line-through" : ""}`}>{c}</span>
          <ZBar value={avg[c]} />
          <span className="fc-num w-8 text-right text-ink">{avg[c].toFixed(1)}</span>
          <span className={`w-8 text-right fc-num ${need[c] > 1.1 ? "text-warn" : need[c] < 0.9 ? "text-ink-3" : "text-ink-3"}`}>
            {punted ? "punt" : need[c].toFixed(2)}
          </span>
        </div>
        );
      })}
    </div>
  );
}
