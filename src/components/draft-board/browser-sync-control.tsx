"use client";

import { useEffect, useState } from "react";
import { useBrowserSyncStore } from "@/store/browser-sync-store";
import { browserLabel, yahooAlert } from "@/store/browser-sync";
import { useDraftStore } from "@/store/draft-store";
import { useYahooStore } from "@/store/yahoo-store";
import { UnmappedFix } from "./yahoo-control";

function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

const TONE = { off: "text-ink-3", waiting: "text-brand", live: "text-pos", stale: "text-warn" } as const;

/**
 * Top-bar "Browser sync" indicator for picks pushed by the Yahoo draft room userscript (extension/).
 * Enabling it switches to Manual (bots off, "Mock vs bots" locked), like Yahoo live sync, and follows the draft via polling.
 */
export function BrowserSyncControl() {
  const enabled = useBrowserSyncStore((s) => s.enabled);
  const status = useBrowserSyncStore((s) => s.status);
  const error = useBrowserSyncStore((s) => s.error);
  const yahooLive = useYahooStore((s) => s.liveSync);
  const draftId = useDraftStore((s) => s.draft?.id ?? null);
  const [open, setOpen] = useState(false);
  const now = useNow(enabled);

  // Start/restart polling when the active draft changes (and restore the persisted toggle on first load).
  useEffect(() => {
    useBrowserSyncStore.getState().attach(draftId);
  }, [draftId]);

  const { label, tone } = browserLabel(enabled, status, now);
  return (
    <div className="relative">
      <button
        data-testid="browser-status"
        data-state={tone}
        onClick={() => setOpen(!open)}
        className={`rounded-md border border-rule bg-raised px-2 py-0.5 text-[11px] hover:bg-track ${TONE[tone]}`}
      >
        {label}
      </button>
      {open && (
        <div data-testid="browser-popover" className="absolute right-0 top-7 z-20 flex w-72 flex-col gap-2 rounded-md border border-rule bg-panel p-2 text-[11px] shadow-lg">
          <label className="flex items-center gap-2">
            <input
              data-testid="browser-toggle"
              type="checkbox"
              checked={enabled}
              disabled={!enabled && yahooLive}
              onChange={(e) => useBrowserSyncStore.getState().setEnabled(e.target.checked)}
            />
            <span className="font-semibold">Follow Yahoo draft room</span>
            <span className="text-ink-3">(Manual, bots off)</span>
          </label>
          {!enabled && yahooLive && <p className="text-warn">Turn off Yahoo live sync first.</p>}
          <p className="text-ink-2">Picks come from the Safari userscript (read-only). See extension/README.md.</p>
          {enabled && (
            <p data-testid="browser-last-received" className="text-ink-2">
              {status ? `Last received ${Math.round(Math.max(0, now - status.receivedAt) / 1000)}s ago · ${status.received} on page (highest #${status.highestPick}) · ${status.totalIngested} pulled` : "Nothing received yet — open the Yahoo draft room in Safari."}
            </p>
          )}
          {enabled && error && <p className="text-warn">App unreachable: {error}</p>}
        </div>
      )}
    </div>
  );
}

/** Problems reported by the last delivery: unmapped name (with manual fix), recorded-pick mismatches, conflicts. */
export function BrowserSyncBanner() {
  const enabled = useBrowserSyncStore((s) => s.enabled);
  const status = useBrowserSyncStore((s) => s.status);
  if (!enabled || !status) return null;
  const u = status.unmapped;
  return (
    <>
      {u && (
        <UnmappedFix
          testPrefix="browser"
          pick={u.pick}
          name={u.name}
          source="Yahoo page"
          hint={u.reason === "ambiguous" ? `matches several players (${(u.candidates ?? []).join(", ")}).` : "isn't in your player list."}
          onResolve={(id) => void useBrowserSyncStore.getState().resolveUnmapped(id)}
        />
      )}
      {status.conflict && (
        <div data-testid="browser-conflict" className="bg-warn-bg px-3 py-1 text-[11px] text-warn">
          Yahoo pick #{status.conflict.pick} is {status.conflict.name}, but you already have them at pick #{status.conflict.alreadyAtPick}. Undo the wrong pick; sync resumes automatically.
        </div>
      )}
      {status.mismatches.length > 0 && (
        <div data-testid="browser-mismatch" className="bg-warn-bg px-3 py-1 text-[11px] text-warn">
          Board differs from the Yahoo page (not auto-corrected):{" "}
          {status.mismatches.slice(0, 3).map((m) => `#${m.pick} you have ${m.ours}, Yahoo shows ${m.seen}`).join("; ")}
          {status.mismatches.length > 3 ? ` (+${status.mismatches.length - 3} more)` : ""}
        </div>
      )}
    </>
  );
}

/**
 * Red/amber alerts while following a live Yahoo draft: no delivery for 15 s+ (Safari paused the tab / window hidden),
 * the tab reports it is in the background, or Yahoo's side panel is not on PICKS (so the userscript cannot read picks).
 */
export function YahooAlertBanner() {
  const enabled = useBrowserSyncStore((s) => s.enabled);
  const status = useBrowserSyncStore((s) => s.status);
  const active = useDraftStore((s) => s.draft?.status === "active");
  const now = useNow(enabled);
  const [mountedAt] = useState(() => Date.now());
  const a = yahooAlert({ enabled, draftActive: !!active, status, now, sinceMs: Math.max(0, now - mountedAt) });
  if (a.kind === "none") return null;
  const red = a.kind === "panel" || a.kind === "page-hidden" || (a.kind === "quiet" && a.level === "red");
  return (
    <div
      role="alert"
      data-testid={a.kind === "quiet" ? "yahoo-quiet" : a.kind === "panel" ? "yahoo-panel-alert" : "yahoo-page-hidden"}
      data-level={red ? "red" : "amber"}
      className={`px-3 py-1.5 text-[12px] font-bold ${red ? "animate-pulse bg-neg text-brand-ink" : "bg-warn text-canvas"}`}
    >
      ⚠ {a.message}
      {a.kind === "quiet" && ` (last delivery ${Math.round(a.ageMs / 1000)}s ago)`}
    </div>
  );
}
