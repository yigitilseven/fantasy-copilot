"use client";

import { useEffect, useMemo, useRef } from "react";
import { BOT_DELAY_MS, useDraftStore } from "@/store/draft-store";
import { DraftSummary } from "@/components/draft-board/summary";
import { deriveDraft } from "@/store/derived";
import { TopBar } from "@/components/draft-board/top-bar";
import { YahooBanner } from "@/components/draft-board/yahoo-control";
import { BrowserSyncBanner, YahooAlertBanner } from "@/components/draft-board/browser-sync-control";
import { PredraftPanel } from "@/components/draft-board/predraft-checklist";
import { RecentPicks } from "@/components/draft-board/recent-picks";
import { RosterList } from "@/components/roster/roster-list";
import { CategoryProfile } from "@/components/categories/category-profile";
import { PlayerTable } from "@/components/player-table/player-table";
import { buildRows } from "@/components/player-table/rows";
import { RecommendationBar } from "@/components/recommendation/recommendation-bar";

export default function DraftPage() {
  const s = useDraftStore();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void useDraftStore.getState().init();
  }, []);

  const derived = useMemo(() => deriveDraft(s.draft), [s.draft]);

  // Pick up a strategy changed from the Yahoo overlay (and picks from other tabs) within ~3 s, and on focus.
  const draftId = s.draft?.id ?? null;
  useEffect(() => {
    if (draftId === null) return;
    const tick = () => {
      if (document.visibilityState === "visible") void useDraftStore.getState().refreshDraft();
    };
    const t = setInterval(tick, 3000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", tick);
    };
  }, [draftId]);

  // Mock mode bot driver: when it is not the user's turn, run bots after the configured delay.
  // Instant = all picks to the user's turn in one call; otherwise one pick per tick so picks roll in.
  const botsDue = s.mode === "mock" && !s.botsPaused && !s.busy && !!derived && !derived.complete && !derived.isUserOnClock;
  const botSpeed = s.botSpeed;
  useEffect(() => {
    if (!botsDue) return;
    const t = setTimeout(() => void useDraftStore.getState().runBots(botSpeed !== "instant"), BOT_DELAY_MS[botSpeed]);
    return () => clearTimeout(t);
  }, [botsDue, botSpeed, s.draft]);
  const rows = useMemo(
    () =>
      buildRows(s.scores, s.recordById, s.valuations, {
        search: s.search, position: s.positionFilter, sortKey: s.sortKey, sortDir: s.sortDir,
      }),
    [s.scores, s.recordById, s.valuations, s.search, s.positionFilter, s.sortKey, s.sortDir],
  );

  // Keyboard shortcuts. Latest values via ref to keep one stable listener.
  const kb = useRef({ rows, complete: false });
  const complete = derived?.complete ?? false;
  useEffect(() => {
    kb.current = { rows, complete };
  }, [rows, complete]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useDraftStore.getState();
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const { rows: r, complete } = kb.current;
      const sel = Math.min(st.selectedIndex, r.length - 1);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        st.setSelectedIndex(Math.min(r.length - 1, sel + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        st.setSelectedIndex(Math.max(0, sel - 1));
      } else if (e.key === "Enter") {
        if (!typing && t && t.tagName === "BUTTON") return; // let focused buttons activate
        const row = r[sel];
        if (row && !complete) {
          e.preventDefault();
          if (typing) (t as HTMLInputElement).blur();
          void st.draftPlayer(row.score.playerId);
        }
      } else if (typing) {
        return;
      } else if (e.key === "u" || e.key === "U") {
        e.preventDefault();
        void st.undo();
      } else if (e.key === "s" || e.key === "S" || e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!s.draft || !derived) {
    return (
      <main className="flex h-screen items-center justify-center bg-canvas text-xs text-ink-2">
        {s.lastError ? (
          <div className="text-center">
            <p className="text-neg">{s.lastError}</p>
            <button className="mt-2 rounded-sm bg-track px-2 py-1" onClick={() => void s.init()}>Retry</button>
          </div>
        ) : (
          "Loading draft…"
        )}
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col overflow-y-auto bg-canvas text-ink md:overflow-hidden">
      <TopBar derived={derived} />
      <PredraftPanel derived={derived} />
      <YahooBanner />
      <YahooAlertBanner />
      <BrowserSyncBanner />
      {s.lastError && (
        <div data-testid="warning" className="flex items-center gap-3 bg-warn-bg px-3 py-1 text-[11px] text-warn">
          <span>{s.lastError}</span>
          <button className="ml-auto text-warn hover:text-warn" onClick={s.dismissError}>dismiss</button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 max-md:[&>*]:min-h-[60vh] md:grid-cols-[250px_minmax(0,1fr)_240px]">
        <aside className="overflow-y-auto border-b border-rule bg-panel max-md:order-2 md:border-b-0 md:border-r">
          <RosterList />
          <div className="border-t border-rule">
            <CategoryProfile rosterIds={derived.userRosterIds} valuations={s.valuations} strategy={s.draft.strategy} />
          </div>
        </aside>
        <section className="flex min-h-0 flex-col max-md:order-1">
          {derived.complete ? (
            <DraftSummary />
          ) : (
            <PlayerTable rows={rows} searchRef={searchRef} />
          )}
        </section>
        <aside className="flex min-h-0 flex-col border-t border-rule bg-panel max-md:order-3 md:border-l md:border-t-0">
          <RecentPicks />
        </aside>
      </div>
      {!derived.complete && <RecommendationBar rows={rows} derived={derived} />}
    </main>
  );
}
