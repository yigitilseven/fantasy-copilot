"use client";

import { useEffect } from "react";
import { evaluatePredraft, predraftProblems, PREDRAFT_POLL_MS, type PredraftRow, type RowState } from "@/store/predraft";
import { usePredraftStore } from "@/store/predraft-store";
import { useBrowserSyncStore } from "@/store/browser-sync-store";
import { useDraftStore } from "@/store/draft-store";
import { useYahooStore } from "@/store/yahoo-store";
import type { DraftDerived } from "@/store/derived";

function useRows(): PredraftRow[] {
  const s = usePredraftStore();
  const draft = useDraftStore((d) => d.draft);
  const sync = useBrowserSyncStore((b) => b.enabled);
  return evaluatePredraft({
    news: s.news,
    proj: s.proj,
    heartbeat: s.heartbeat,
    browserSync: sync,
    teams: draft?.teams ?? 0,
    userSlot: draft?.userSlot ?? 0,
    now: s.now,
  });
}

/** Shown automatically while currentPick === 1 (and not complete); the chip overrides it either way for the active draft. */
function usePanelVisible(derived: DraftDerived | null): { visible: boolean; auto: boolean } {
  const draftId = useDraftStore((d) => d.draft?.id ?? null);
  const override = usePredraftStore((s) => (s.overrideDraftId === draftId ? s.override : null));
  const auto = !!derived && !derived.complete && derived.currentPick === 1;
  return { visible: override ?? auto, auto };
}

const ICON: Record<RowState, { mark: string; cls: string }> = {
  ok: { mark: "✓", cls: "text-pos" },
  bad: { mark: "✗", cls: "text-neg" },
  wait: { mark: "…", cls: "text-ink-3" },
};

/** Top-bar "Pre-draft ✓/✗" chip. Also owns the 3 s status polling (while the page is visible). */
export function PredraftChip({ derived }: { derived: DraftDerived }) {
  const rows = useRows();
  const draftId = useDraftStore((d) => d.draft?.id ?? null);
  const { visible, auto } = usePanelVisible(derived);
  const bad = predraftProblems(rows);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void usePredraftStore.getState().load();
    };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, PREDRAFT_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [draftId]);

  return (
    <button
      data-testid="predraft-chip"
      data-state={bad ? "bad" : "ok"}
      aria-expanded={visible}
      title="Pre-draft checklist: news, projections, Yahoo tab, picks panel, browser sync"
      onClick={() => usePredraftStore.getState().toggle(auto, draftId)}
      className={`rounded-md border border-rule bg-raised px-2 py-0.5 text-[11px] hover:bg-track ${bad ? "text-warn" : "text-pos"}`}
    >
      Pre-draft {bad ? `✗ (${bad})` : "✓"}
    </button>
  );
}

/** Compact checklist panel under the top bar: visible at pick 1 or when expanded from the chip. */
export function PredraftPanel({ derived }: { derived: DraftDerived }) {
  const rows = useRows();
  const { visible } = usePanelVisible(derived);
  const busy = usePredraftStore((s) => s.refreshing || !!s.news?.refreshing);
  const syncOn = useBrowserSyncStore((b) => b.enabled);
  const yahooLive = useYahooStore((y) => y.liveSync);
  if (!visible) return null;

  const action = (r: PredraftRow) => {
    if (r.key === "news" && r.state === "bad")
      return (
        <button
          data-testid="predraft-news-refresh"
          disabled={busy}
          onClick={() => void usePredraftStore.getState().refreshNews()}
          className="ml-2 inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-px font-semibold hover:bg-track disabled:opacity-60"
        >
          {busy && <span data-testid="predraft-spinner" className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-rule border-t-transparent" />}
          {busy ? "Refreshing" : "Refresh"}
        </button>
      );
    if (r.key === "browser-sync" && r.state === "bad")
      return (
        <button
          data-testid="predraft-sync-on"
          disabled={syncOn || yahooLive}
          title={yahooLive ? "Turn off Yahoo live sync first" : undefined}
          onClick={() => useBrowserSyncStore.getState().setEnabled(true)}
          className="ml-2 rounded-md bg-raised px-1.5 py-px font-semibold hover:bg-track disabled:opacity-60"
        >
          Turn on
        </button>
      );
    return null;
  };

  return (
    <section data-testid="predraft-panel" className="border-b border-rule bg-panel px-3 py-1.5 text-[11px]">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-bold uppercase tracking-wide text-ink-2">Before the draft</span>
        <button data-testid="predraft-close" onClick={() => usePredraftStore.getState().toggle(true, useDraftStore.getState().draft?.id ?? null)} className="ml-auto text-ink-3 hover:text-ink" aria-label="Hide checklist">
          hide
        </button>
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 md:grid-cols-2">
        {rows.map((r) => (
          <li key={r.key} data-testid={`predraft-${r.key}`} data-state={r.state} className="flex items-center gap-1.5">
            <span className={`w-3 shrink-0 text-center font-bold ${ICON[r.state].cls}`}>{ICON[r.state].mark}</span>
            <span className="w-24 shrink-0 text-ink-2">{r.label}</span>
            <span className={r.state === "bad" ? "text-ink" : "text-ink-2"}>{r.text}</span>
            {action(r)}
          </li>
        ))}
      </ul>
    </section>
  );
}
