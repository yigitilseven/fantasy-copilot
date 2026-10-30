"use client";

import { useEffect, useState } from "react";
import { leagueConfig } from "@/config/default-league";
import { useDraftStore } from "@/store/draft-store";
import { useBrowserSyncStore } from "@/store/browser-sync-store";
import { useYahooStore } from "@/store/yahoo-store";
import { formatAgo } from "@/store/yahoo-sync";

function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

/** Top-bar Yahoo control: connection status, league picker, live-sync toggle. Manual mode never depends on it. */
export function YahooControl() {
  const conn = useYahooStore((s) => s.conn);
  const leagues = useYahooStore((s) => s.leagues);
  const leagueKey = useYahooStore((s) => s.leagueKey);
  const liveSync = useYahooStore((s) => s.liveSync);
  const poller = useYahooStore((s) => s.poller);
  const error = useYahooStore((s) => s.error);
  const browserSync = useBrowserSyncStore((s) => s.enabled);
  const draft = useDraftStore((s) => s.draft);
  const busy = useDraftStore((s) => s.busy);
  const [open, setOpen] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const now = useNow(liveSync);

  useEffect(() => {
    void useYahooStore.getState().loadStatus();
  }, []);

  if (conn === "unknown" || conn === "loading") return <span data-testid="yahoo-status" className="text-[11px] text-ink-3">Yahoo…</span>;
  if (conn !== "authenticated")
    return (
      <span data-testid="yahoo-status" title="run pnpm yahoo:auth" className="cursor-help text-[11px] text-ink-3">
        Yahoo: not connected
      </span>
    );

  const league = leagues.find((l) => l.leagueKey === leagueKey) ?? null;
  const teamMismatch = !!(league?.numTeams && draft && league.numTeams !== draft.teams);
  const slotMismatch = !!(league?.userSlot && draft && league.userSlot !== draft.userSlot);

  let label = "Yahoo: connected";
  let tone = "text-ink";
  if (liveSync) {
    if (poller.phase === "paused") [label, tone] = ["Yahoo: sync paused", "text-warn"];
    else if (poller.phase === "complete") [label, tone] = ["Yahoo: draft complete", "text-pos"];
    else if (poller.delayed) [label, tone] = ["Yahoo: delayed", "text-warn"];
    else [label, tone] = [`Yahoo: live · ${formatAgo(poller.lastSyncAt, now).replace("synced ", "")}`, "text-pos"];
  }

  return (
    <div className="relative">
      <button
        data-testid="yahoo-status"
        data-state={liveSync ? poller.phase : "connected"}
        onClick={() => setOpen(!open)}
        className={`rounded-md border border-rule bg-raised px-2 py-0.5 text-[11px] hover:bg-track ${tone}`}
      >
        {label}
      </button>
      {open && (
        <div data-testid="yahoo-popover" className="absolute right-0 top-7 z-20 flex w-72 flex-col gap-2 rounded-md border border-rule bg-panel p-2 text-[11px] shadow-lg">
          {leagues.length === 0 ? (
            <p className="text-ink-2">{error ?? "No NBA leagues found on this Yahoo account."}</p>
          ) : (
            <label className="flex items-center justify-between gap-2">
              League
              <select
                data-testid="yahoo-league-select"
                value={leagueKey ?? ""}
                onChange={(e) => useYahooStore.getState().selectLeague(e.target.value || null)}
                className="w-44 rounded-md bg-raised px-1 py-0.5"
              >
                <option value="">Select…</option>
                {leagues.map((l) => (
                  <option key={l.leagueKey} value={l.leagueKey}>
                    {l.name}
                    {l.numTeams ? ` (${l.numTeams} teams)` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {league && (
            <>
              <label className="flex items-center gap-2">
                <input
                  data-testid="yahoo-live-toggle"
                  type="checkbox"
                  checked={liveSync}
                  disabled={!liveSync && (browserSync || teamMismatch || draft?.status !== "active")}
                  onChange={(e) => setToggleError(useYahooStore.getState().setLiveSync(e.target.checked))}
                />
                <span className="font-semibold">Live sync</span>
                <span className="text-ink-3">(switches to Manual, bots off)</span>
              </label>
              {liveSync && (
                <p data-testid="yahoo-last-sync" className="text-ink-2">
                  {poller.phase === "paused" ? "Paused after repeated failures." : formatAgo(poller.lastSyncAt, now)}
                  {poller.totalIngested > 0 && ` · ${poller.totalIngested} picks pulled`}
                </p>
              )}
              {liveSync && poller.phase === "paused" && (
                <button data-testid="yahoo-resume" onClick={() => useYahooStore.getState().resume()} className="self-start rounded-md bg-brand text-brand-ink px-2 py-0.5 font-semibold hover:brightness-110">
                  Resume sync
                </button>
              )}
              {teamMismatch && <p data-testid="yahoo-mismatch" className="text-warn">Local draft has {draft!.teams} teams; this league has {league.numTeams}. Create a matching draft to sync.</p>}
              {!teamMismatch && slotMismatch && <p className="text-warn">Your slot here is {draft!.userSlot}; Yahoo says {league.userSlot}.</p>}
              {league.numTeams && (
                <button
                  data-testid="yahoo-new-draft"
                  disabled={busy || liveSync}
                  onClick={() => {
                    if (draft!.picks.length > 0 && !confirm("Start a new draft from this league? The current draft stays saved but will no longer be the active one.")) return;
                    void useDraftStore.getState().newLeagueDraft({ teams: league.numTeams!, userSlot: league.userSlot ?? leagueConfig.userSlot, rounds: draft?.rounds ?? leagueConfig.rounds });
                  }}
                  className="self-start rounded-md bg-raised px-2 py-0.5 font-semibold hover:bg-track disabled:opacity-40"
                >
                  New draft: {league.numTeams} teams{league.userSlot ? `, slot ${league.userSlot}` : ""}
                </button>
              )}
              {toggleError && <p className="text-warn">{toggleError}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Non-blocking sync problems: delayed/paused notices and the unmapped-player quick fix. */
export function YahooBanner() {
  const liveSync = useYahooStore((s) => s.liveSync);
  const poller = useYahooStore((s) => s.poller);
  if (!liveSync) return null;

  return (
    <>
      {poller.phase === "paused" && (
        <div data-testid="yahoo-banner" className="flex items-center gap-3 bg-warn-bg px-3 py-1 text-[11px] text-warn">
          <span>Yahoo sync paused after repeated failures{poller.lastError ? ` (${poller.lastError.code}: ${poller.lastError.message})` : ""} — manual entry still works.</span>
          <button data-testid="yahoo-banner-resume" className="ml-auto rounded-md bg-warn-bg px-2 py-0.5 font-semibold text-warn" onClick={() => useYahooStore.getState().resume()}>Resume</button>
        </div>
      )}
      {poller.phase === "running" && poller.delayed && (
        <div data-testid="yahoo-banner" className="bg-warn-bg px-3 py-1 text-[11px] text-warn">
          Yahoo delayed — manual entry still works. Retrying every {Math.round(poller.delayMs / 1000)}s ({poller.consecutiveFailures}/3).
        </div>
      )}
      {poller.phase === "running" && !poller.delayed && poller.lastError && (
        <div data-testid="yahoo-banner" className="bg-warn-bg px-3 py-1 text-[11px] text-warn">Yahoo sync issue: {poller.lastError.message}</div>
      )}
      {poller.unmapped && (
        <UnmappedFix testPrefix="yahoo" pick={poller.unmapped.pick} name={poller.unmapped.name ?? poller.unmapped.yahooPlayerKey} source="Yahoo" onResolve={(id) => void useYahooStore.getState().resolveUnmapped(id)} />
      )}
    </>
  );
}

/**
 * "This pick's player isn't in your list" banner with a search box; choosing a player drafts it manually at the
 * current pick. Shared by Yahoo live sync (testPrefix "yahoo") and Browser sync ("browser").
 */
export function UnmappedFix({ testPrefix, pick, name, source, hint, onResolve }: { testPrefix: string; pick: number; name: string; source: string; hint?: string; onResolve: (playerId: string) => void }) {
  const recordById = useDraftStore((s) => s.recordById);
  const draft = useDraftStore((s) => s.draft);
  const [q, setQ] = useState("");
  const drafted = new Set(draft?.picks.map((p) => p.playerId));
  const matches =
    q.trim().length >= 2
      ? Object.values(recordById)
          .filter((r) => !drafted.has(r.player.id) && r.player.name.toLowerCase().includes(q.trim().toLowerCase()))
          .sort((a, b) => a.market.rank - b.market.rank)
          .slice(0, 6)
      : [];
  return (
    <div data-testid={`${testPrefix}-unmapped`} className="relative flex items-center gap-3 bg-brand-bg px-3 py-1 text-[11px] text-brand">
      <span>
        {source} pick #{pick}: <b data-testid={`${testPrefix}-unmapped-name`}>{name}</b> {hint ?? "isn't in your player list."} Pick the matching player:
      </span>
      <input
        data-testid={`${testPrefix}-unmapped-search`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search player…"
        className="w-44 rounded-md bg-raised px-1.5 py-0.5 text-ink"
      />
      {matches.length > 0 && (
        <ul className="absolute left-3 top-7 z-30 w-64 rounded-md border border-rule bg-panel text-ink shadow-lg">
          {matches.map((r) => (
            <li key={r.player.id}>
              <button
                data-testid={`${testPrefix}-unmapped-option`}
                className="flex w-full justify-between px-2 py-1 text-left hover:bg-track"
                onClick={() => {
                  setQ("");
                  onResolve(r.player.id);
                }}
              >
                <span>{r.player.name}</span>
                <span className="text-ink-3">{r.player.nbaTeam}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
