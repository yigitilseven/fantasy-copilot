"use client";

import { useDraftStore } from "@/store/draft-store";
import { deriveDraft } from "@/store/derived";
import { useMemo } from "react";

export function RosterList() {
  const draft = useDraftStore((s) => s.draft);
  const recordById = useDraftStore((s) => s.recordById);
  const d = useMemo(() => deriveDraft(draft), [draft]);
  if (!draft || !d) return null;
  const slots = Array.from({ length: draft.rounds }, (_, i) => d.userRosterIds[i] ?? null);
  const myPicks = draft.picks.filter((p) => p.teamSlot === draft.userSlot);
  return (
    <div className="px-3 py-2">
      <div className="mb-1 fc-label">My roster</div>
      <ol data-testid="roster-list" className="text-[11px]">
        {slots.map((id, i) => {
          const rec = id ? recordById[id] : null;
          return (
            <li key={i} data-testid="roster-item" className="fc-num flex items-baseline gap-1.5 py-px">
              <span className="w-4 text-right text-ink-3">{i + 1}</span>
              {rec ? (
                <>
                  <span className="truncate font-medium text-ink">{rec.player.name}</span>
                  <span className="ml-auto whitespace-nowrap text-ink-3">{rec.player.positions.join("/")}</span>
                  <span className="w-7 text-right text-ink-3">#{myPicks[i]?.pick}</span>
                </>
              ) : (
                <span className="text-ink-3">—</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
