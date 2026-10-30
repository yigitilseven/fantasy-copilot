"use client";

/* App chrome: header (team, day picker, sync age, settings), bottom tab bar on phones (84px, thumb reach), top nav on desktop,
 * refresh progress / notice bars and the no-league / load-error states. Content is inset 16px. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ago, dayLabel } from "./format";
import { IconChevron, IconInfo, IconLeague, IconMatchup, IconMoves, IconSliders, IconToday, Logo } from "./icons";
import { cx, ErrorBar, Skeleton } from "./kit";
import { useSeason } from "./season-data";
import { useWorkerStatus } from "./settings-parts";
import { NoLeagueState, OfflineBanner, StaleStrip, SyncProblemBanner, useOnline } from "./states";

/** Roster data older than this shows the stale strip (hourly sync: a few missed runs). */
const STALE_MS = 6 * 3600_000;

const TABS = [
  { href: "/today", label: "Today", Icon: IconToday },
  { href: "/moves", label: "Moves", Icon: IconMoves },
  { href: "/matchup", label: "Matchup", Icon: IconMatchup },
  { href: "/league", label: "League", Icon: IconLeague },
] as const;

function DayPicker({ className }: { className?: string }) {
  const { data, date, setDate } = useSeason();
  const shown = date || data?.date || "";
  return (
    <label className={cx("relative inline-flex cursor-pointer items-center gap-1 text-[15px] text-ink", className)}>
      {shown ? dayLabel(shown) : "Today"}
      <IconChevron />
      <input
        type="date"
        aria-label="Day"
        value={shown}
        onChange={(e) => setDate(e.target.value === data?.realDate ? "" : e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
}

function SyncAge({ className }: { className?: string }) {
  const { sync, data } = useSeason();
  const at = sync?.lastAttemptAt ?? data?.freshness.roster.at ?? null;
  // "now" from the last server response (refreshed every minute) keeps render pure
  const now = Date.parse(sync?.now ?? data?.generatedAt ?? "") || 0;
  const stale = !at || now - Date.parse(at) > 3 * 3600_000;
  const failed = !!sync?.stopped;
  return (
    <Link href="/settings#data" className={cx("inline-flex items-center gap-1 text-[13.5px]", failed ? "text-neg" : stale ? "text-warn" : "text-ink-2", className)} data-testid="sync-age">
      {failed ? "Sync problem" : `Synced ${ago(at, now)}`} <IconInfo />
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data, error, busy, notice, dismissNotice, reload, refreshAll } = useSeason();
  const worker = useWorkerStatus();
  const online = useOnline();
  const rosterAge = data?.freshness.roster.ageMs ?? null;
  const team = data?.league.userTeam ?? "Fantasy Copilot";
  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink" data-testid="copilot-shell">
      {/* Phone header */}
      <header className="px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] md:hidden">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <div className="min-w-0 flex-1 truncate text-[20px] font-semibold">{team}</div>
          <Link href="/settings" aria-label="Settings" className="p-1 text-ink-2 hover:text-ink"><IconSliders /></Link>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <DayPicker />
          <SyncAge />
        </div>
      </header>

      {/* Desktop header */}
      <header className="hidden border-b border-rule px-8 pb-4 pt-6 md:block">
        <div className="flex items-center gap-6">
          <Link href="/today" className="flex items-center gap-3"><Logo size={34} /><span className="text-[19px]">Fantasy Copilot</span></Link>
          <nav className="mx-auto flex gap-8 text-[15px]">
            {TABS.map((t) => <Link key={t.href} href={t.href} className={active(t.href) ? "font-semibold text-brand" : "text-ink-2 hover:text-ink"}>{t.label}</Link>)}
          </nav>
          <SyncAge />
          <Link href="/settings" aria-label="Settings" className={cx("p-1", active("/settings") ? "text-brand" : "text-ink-2 hover:text-ink")}><IconSliders className="h-5 w-5" /></Link>
        </div>
        <div className="mt-5 flex items-center justify-between text-[13.5px] text-ink-2">
          <span>{data ? `${data.league.userTeam}  /  ${data.league.name}  /  ${data.league.teams}-team H2H · 9-category` : " "}</span>
          <DayPicker className="text-[13.5px]" />
        </div>
      </header>

      {!online && <OfflineBanner />}
      {worker?.available && worker.needsLogin && <div className="mx-4 mb-2 md:mx-8 md:mt-3"><SyncProblemBanner novncUrl={worker.novncUrl} /></div>}
      {data && !data.preview && rosterAge != null && rosterAge > STALE_MS && !busy && (
        <div className="mx-4 mb-2 md:mx-8 md:mt-3"><StaleStrip at={data.freshness.roster.at} onSync={() => void refreshAll()} /></div>
      )}
      {busy && <div className="mx-4 mb-2 rounded-xl bg-brand-bg px-4 py-2.5 text-[14px] text-brand md:mx-8 md:mt-3" role="status" data-testid="busy">{busy}</div>}
      {notice && (
        <div className="mx-4 mb-2 flex items-start gap-3 rounded-xl bg-raised px-4 py-2.5 text-[14px] text-ink md:mx-8 md:mt-3" data-testid="season-notice">
          <span className="flex-1">{notice}</span>
          <button onClick={dismissNotice} aria-label="Dismiss" className="text-ink-2">✕</button>
        </div>
      )}

      <main className="flex-1 px-4 pb-[calc(96px+env(safe-area-inset-bottom))] md:px-8 md:pb-10">
        {error?.code === "LEAGUE_NOT_FOUND" ? (
          <div className="mt-6"><NoLeagueState /></div>
        ) : error && !data ? (
          <div className="mt-6"><ErrorBar message={error.message} onRetry={reload} /></div>
        ) : !data ? (
          <div className="mt-6"><Skeleton lines={4} /></div>
        ) : (
          children
        )}
      </main>

      {/* Phone tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Sections">
        <div className="grid h-[72px] grid-cols-4">
          {TABS.map(({ href, label, Icon }) => (
            <Link key={href} href={href} className={cx("flex flex-col items-center justify-center gap-1 text-[12.5px]", active(href) ? "font-semibold text-brand" : "text-ink-2")} aria-current={active(href) ? "page" : undefined}>
              <Icon />
              {label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
