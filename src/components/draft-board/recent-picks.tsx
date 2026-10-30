"use client";

import { useDraftStore } from "@/store/draft-store";

export function RecentPicks() {
  const draft = useDraftStore((s) => s.draft);
  const recordById = useDraftStore((s) => s.recordById);
  if (!draft) return null;
  const picks = [...draft.picks].reverse().slice(0, 60);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 py-2 fc-label">
        Draft board · {draft.picks.length}/{draft.teams * draft.rounds}
      </div>
      <ol data-testid="pick-log" className="min-h-0 flex-1 overflow-y-auto text-[11px]">
        {picks.length === 0 && <li className="px-2 text-ink-3">No picks yet.</li>}
        {picks.map((p) => {
          const mine = p.teamSlot === draft.userSlot;
          return (
            <li
              key={p.pick}
              data-testid="pick-log-item"
              className={`flex items-baseline gap-1.5 px-2 py-px ${mine ? "bg-pos-bg text-pos" : "text-ink"}`}
            >
              <span className="w-7 text-right fc-num text-ink-3">{p.pick}</span>
              <span className="w-6 fc-num text-ink-3">T{p.teamSlot}</span>
              <span className="truncate">{recordById[p.playerId]?.player.name ?? p.playerId}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
