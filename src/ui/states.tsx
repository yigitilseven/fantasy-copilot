"use client";

/* Page states from the "State gallery · Coverage and recovery" design that the kit (Skeleton, EmptyState, ErrorBar) does not cover.
 * Cached figures stay visible with their age; missing data is never replaced by zero. Not wired into the shell yet. */
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ago } from "./format";
import { Badge, Button, Card, cx, Label, LinkButton } from "./kit";
import { IconExternal, IconInfo } from "./icons";

const TONE = { warn: "bg-warn-bg text-warn", neg: "bg-neg-bg text-neg", neutral: "bg-raised text-ink-2" } as const;

/** Thin colored strip: a message, an optional action on the right. */
function Strip({ tone, children, action, role }: { tone: keyof typeof TONE; children: React.ReactNode; action?: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <div role={role} className={cx("flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-[14px]", TONE[tone])}>
      <span className="min-w-0">{children}</span>
      {action && <span className="shrink-0 font-semibold">{action}</span>}
    </div>
  );
}

/** "Roster last synced 26 h ago · Advice may be out of date." Shown above cached advice once the data is older than the threshold. */
export function StaleBanner({ what = "Roster", at, onSync, busy, className }: { what?: string; at: string | null | undefined; onSync?: () => void; busy?: boolean; className?: string }) {
  return (
    <Card className={cx("p-4", className)} data-testid="stale-banner">
      <Label>Stale / cached advice</Label>
      <Badge tone="warn" className="mt-2">{what} last synced {at ? ago(at) : "never"}</Badge>
      <div className="mt-2 text-[16px] text-ink">Advice may be out of date.</div>
      <div className="mt-1 text-[13px] text-ink-2">The last successful roster and matchup are shown with their timestamp. Category projections are not recomputed from partial sources.</div>
      {onSync && <Button className="mt-3 w-full" disabled={busy} onClick={onSync}>{busy ? "Syncing…" : "Sync now"}</Button>}
    </Card>
  );
}

/** Compact one-line variant for the top of a screen. */
export function StaleStrip({ what = "Roster", at, onSync, busy }: { what?: string; at: string | null | undefined; onSync?: () => void; busy?: boolean }) {
  return (
    <Strip tone="warn" role="status" action={onSync && <button onClick={onSync} disabled={busy} className="disabled:opacity-50">{busy ? "Syncing…" : "Sync now"}</button>}>
      {what} last synced {at ? ago(at) : "never"}. Advice may be out of date.
    </Strip>
  );
}

/** "Yahoo needs you to log in again · Open remote browser". novncUrl comes from /api/season/worker-status. */
export function SyncProblemBanner({ novncUrl, detail, className }: { novncUrl?: string | null; detail?: string; className?: string }) {
  const href = novncUrl && /^https?:\/\//.test(novncUrl) ? novncUrl : null;
  return (
    <Card className={cx("p-4", className)} data-testid="sync-problem-banner">
      <Label>Yahoo login failure</Label>
      <Badge tone="neg" className="mt-2">Needs login</Badge>
      <div className="mt-2 text-[17px] text-neg">Yahoo needs you to log in again{href ? " · Open remote browser" : ""}</div>
      {href && <a href={href} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-raised px-4 text-[15px] font-medium text-ink hover:brightness-110">Open remote browser <IconExternal /></a>}
      <div className="mt-2 text-[13px] text-ink-2">{detail ?? "Resume your Yahoo session in the remote browser, then retry the sync. No Copilot login is needed."}</div>
    </Card>
  );
}

/** "Season has not started (first game Oct 20)". Suppress in-season adds advice while it shows. */
export function PreseasonBanner({ firstGame, draftHref = "/draft", className }: { firstGame?: string | null; draftHref?: string; className?: string }) {
  return (
    <Card className={cx("p-4", className)} data-testid="preseason-banner">
      <Label>Preseason</Label>
      <div className="mt-2 text-[19px] text-ink">Season has not started{firstGame ? ` (first game ${firstGame})` : ""}</div>
      <div className="mt-1 text-[13px] text-ink-2">No current matchup probability. Season values, draft tools and the schedule are shown; in-season adds advice is suppressed.</div>
      <LinkButton href={draftHref} className="mt-3 w-full">Review draft room</LinkButton>
    </Card>
  );
}

/** "None of your players play today": a plan-ahead state for the lineup. */
export function NoGamesState({ slots = "0/10 slots", className }: { slots?: string; className?: string }) {
  return (
    <Card className={cx("p-4", className)} data-testid="no-games-state">
      <Label>No games today</Label>
      <div className="mt-2 text-[19px] text-ink">None of your players play today</div>
      <div className="mt-1 text-[13px] text-ink-2">Weekly projections still apply. Use today to plan, not to force a move.</div>
      <Badge className="mt-2">{slots} · No game dots</Badge>
    </Card>
  );
}

/** Claude analysis unavailable: numbers stay, narrative is missing. */
export function AnalysisFallbackBanner({ onRetry, busy, className }: { onRetry?: () => void; busy?: boolean; className?: string }) {
  return (
    <Card className={cx("p-4", className)} data-testid="analysis-fallback">
      <Label>Analysis fallback</Label>
      <Badge className="mt-2">Engine only</Badge>
      <div className="mt-2 text-[19px] text-ink">Your numbers are ready.</div>
      <div className="mt-1 text-[13px] text-ink-2">Narrative analysis is unavailable. The category model and the lineup and move recommendations remain visible with their source freshness.</div>
      {onRetry && <Button className="mt-3 w-full" disabled={busy} onClick={onRetry}>{busy ? "Retrying…" : "Retry analysis"}</Button>}
    </Card>
  );
}

/** Weekly add limit reached: the move stays visible but "I did this" is disabled by the card. */
export function AddLimitBanner({ used, limit, resetsOn = "Monday", className }: { used?: number; limit?: number; resetsOn?: string; className?: string }) {
  return (
    <Strip tone="warn" role="status">
      <span className={className}>Add limit reached this week{used != null && limit != null ? ` (${used}/${limit})` : ""}. Analysis stays visible; it resets {resetsOn}. IL placement does not use an add.</span>
    </Strip>
  );
}

/** Subscribes to navigator.onLine. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** "You are offline": cached screens stay readable. */
export function OfflineBanner() {
  return (
    <Strip tone="neutral" role="status">
      <span className="inline-flex items-center gap-1.5"><IconInfo />You are offline. Showing the last loaded data; actions need a connection.</span>
    </Strip>
  );
}

/** No league has been created yet (first run, or /api/season answered LEAGUE_NOT_FOUND). */
export function NoLeagueState({ className }: { className?: string }) {
  return (
    <Card className={cx("text-center", className)} data-testid="no-league-state">
      <div className="text-[17px] font-semibold text-ink">No league yet</div>
      <div className="mt-1 text-[13px] text-ink-2">Finish a draft in the draft room, or open your Yahoo league in the remote browser so the first sync can discover it.</div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <LinkButton href="/draft" variant="primary">Open draft room</LinkButton>
        <Link href="/settings#data" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-raised px-4 text-[15px] font-medium text-ink">Data and sync</Link>
      </div>
    </Card>
  );
}
