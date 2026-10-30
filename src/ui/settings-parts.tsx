"use client";

/* Pieces of the Settings screen: section cards, freshness rows, remote browser status, theme, notifications, league settings form. */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SeasonOverview } from "@/server/season";
import type { SyncStatus } from "@/server/season-ingest";
import type { SeasonSettings } from "@/engine/season/types";
import { usePush } from "@/components/push-control";
import { ago } from "./format";
import { IconBell, IconExternal } from "./icons";
import { Badge, Button, Card, cx, Label, Segmented, type Tone } from "./kit";
import { api } from "./season-data";

// ------------------------------------------------------------------ layout helpers

export function Section({ id, title, badge, children }: { id: string; title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-20 p-5" data-testid={`settings-${id}`}>
      <div className="flex items-center justify-between gap-2">
        <Label>{title}</Label>
        {badge}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

export function InfoRow({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[15px] text-ink">{label}</div>
        {hint && <div className="text-[12.5px] text-ink-3">{hint}</div>}
      </div>
      <div className="fc-num shrink-0 text-[15px] text-ink-2">{value}</div>
    </div>
  );
}

const DOT: Record<"ok" | "stale" | "failed", string> = { ok: "bg-ink-3", stale: "bg-warn", failed: "bg-neg" };
const AGE_TEXT: Record<"ok" | "stale" | "failed", string> = { ok: "text-ink-2", stale: "text-warn", failed: "text-neg" };

/** One freshness source: dot, name + detail, age. Neutral = healthy, amber = stale, red = failed. */
export function SourceRow({ name, detail, at, state }: { name: string; detail?: string; at: string | null; state: "ok" | "stale" | "failed" }) {
  return (
    <div className="flex items-center gap-3 border-b border-rule py-2.5 last:border-b-0" data-state={state}>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[state])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[16px] text-ink">{name}</div>
        {detail && <div className="truncate text-[13px] text-ink-2">{detail}</div>}
      </div>
      <div className={cx("fc-num shrink-0 text-[14px]", AGE_TEXT[state])}>{at ? ago(at) : "never"}</div>
    </div>
  );
}

const STALE_MS = 6 * 3_600_000;
const ageState = (ageMs: number | null): "ok" | "stale" => (ageMs == null || ageMs > STALE_MS ? "stale" : "ok");
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "n/a");

/** Freshness per source (from the overview) with the Yahoo sync parts below. */
export function FreshnessList({ d, sync }: { d: SeasonOverview; sync: SyncStatus | null }) {
  const f = d.freshness;
  const failedParts = sync ? Object.entries(sync.parts).filter(([, p]) => !p.ok && p.detail !== "not run") : [];
  return (
    <div>
      <SourceRow name="Roster" detail={sync ? `${sync.roster.count} players · ${f.roster.source === "yahoo-page" ? "from Yahoo" : "from the draft"}` : undefined} at={f.roster.at} state={f.roster.source === "draft" ? "stale" : ageState(f.roster.ageMs)} />
      <SourceRow name="FA pool" detail={`${f.freeAgents.count} players${f.freeAgents.usable ? "" : " · not usable yet"}`} at={f.freeAgents.at} state={!f.freeAgents.usable ? "stale" : ageState(f.freeAgents.ageMs)} />
      <SourceRow name="Matchup" detail={sync?.matchup.week != null ? `Week ${sync.matchup.week}${sync.matchup.opp ? ` vs ${sync.matchup.opp}` : ""}` : undefined} at={f.matchup.at} state={f.matchup.currentWeek ? ageState(f.matchup.ageMs) : "stale"} />
      {sync && <SourceRow name="Teams" detail={`${sync.teamsSynced}/${sync.teamsTotal}`} at={sync.lastFullAt} state={sync.teamsTotal > 0 && sync.teamsSynced < sync.teamsTotal ? "stale" : "ok"} />}
      <SourceRow name="News" detail={f.news.at ? "Player news feed" : "No news fetched yet"} at={f.news.at} state={f.news.stale ? "stale" : "ok"} />
      <SourceRow name="Schedule" detail={f.schedule.assumed ? "Assumed (no games loaded)" : f.schedule.error ? f.schedule.error : `${f.schedule.games} games`} at={f.schedule.fetchedAt} state={f.schedule.error ? "failed" : f.schedule.stale || f.schedule.assumed ? "stale" : "ok"} />
      {failedParts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {failedParts.map(([k]) => <Badge key={k} tone="neg">{PART_LABEL[k] ?? k} · failed</Badge>)}
        </div>
      )}
    </div>
  );
}

const PART_LABEL: Record<string, string> = { discovery: "Discovery", myTeam: "My team", teams: "All teams", matchup: "Matchup", fas: "Free agents", transactions: "Transactions" };

/** The six Yahoo sync parts with their last result. */
export function SyncParts({ sync }: { sync: SyncStatus }) {
  return (
    <div className="mt-1" data-testid="sync-parts">
      {Object.entries(sync.parts).map(([k, p]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-rule py-2 text-[14px] last:border-b-0">
          <span className="text-ink">{PART_LABEL[k] ?? k}</span>
          <span className={cx("min-w-0 truncate text-right", p.ok ? "text-ink-2" : p.detail === "not run" ? "text-ink-3" : "text-neg")}>{p.ok ? "ok" : "failed"} · {p.detail}</span>
        </div>
      ))}
      {sync.parserNeedsUpdate.length > 0 && <div className="mt-2 text-[13px] text-warn">Yahoo changed its pages; the reader needs an update for: {sync.parserNeedsUpdate.join(", ")}.</div>}
      {sync.stopped && <div className="mt-2 text-[13px] text-warn">Sync stopped: {sync.stopped}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ remote browser

export interface WorkerStatus {
  available: boolean;
  detail?: string;
  needsLogin?: boolean;
  lastOkAt?: string | null;
  lastRunAt?: string | null;
  lastOutcome?: string | null;
  runsToday?: number | null;
  maxPerDay?: number | null;
  nextRunAt?: string | null;
  novncUrl?: string | null;
}

/** GET /api/season/worker-status once (the page can also pass `refreshKey` to refetch after a sync). */
export function useWorkerStatus(refreshKey = 0): WorkerStatus | null {
  const [s, setS] = useState<WorkerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api<WorkerStatus>("/api/season/worker-status")
      .then((x) => alive && setS(x))
      .catch((e) => alive && setS({ available: false, detail: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return s;
}

export function RemoteBrowserCard({ w }: { w: WorkerStatus | null }) {
  const href = w?.novncUrl && /^https?:\/\//.test(w.novncUrl) ? w.novncUrl : null;
  const badge = !w ? <Badge>Checking…</Badge> : !w.available ? <Badge>Not connected</Badge> : w.needsLogin ? <Badge tone="neg">Needs login</Badge> : <Badge tone="pos">Logged in</Badge>;
  return (
    <Section id="remote-browser" title="Yahoo remote browser" badge={badge}>
      <div className="text-[15px] text-ink-2">
        {!w ? "Asking the browser worker…" : !w.available ? (w.detail ?? "The browser worker is not reachable.") : w.needsLogin ? "Yahoo needs you to log in again. Open the remote browser and log in by hand, then run a sync." : "Your existing Yahoo session powers roster and matchup sync. No Copilot account needed."}
      </div>
      {w?.available && (
        <div className="mt-2 text-[13px] text-ink-3">
          Last good run {w.lastOkAt ? ago(w.lastOkAt) : "never"}
          {w.runsToday != null && w.maxPerDay != null ? ` · ${w.runsToday}/${w.maxPerDay} runs today` : ""}
          {w.nextRunAt ? ` · next ${when(w.nextRunAt)}` : ""}
          {w.lastOutcome ? ` · last: ${w.lastOutcome}` : ""}
        </div>
      )}
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-raised px-4 text-[15px] font-medium text-ink hover:brightness-110">
          Open remote browser <IconExternal />
        </a>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ notifications

const PUSH_BADGE: Record<string, { tone: Tone; label: string }> = {
  enabled: { tone: "brand", label: "On" },
  "can-enable": { tone: "neutral", label: "Off" },
  blocked: { tone: "warn", label: "Blocked" },
  "install-needed": { tone: "neutral", label: "Install needed" },
  unsupported: { tone: "neutral", label: "Unsupported" },
  insecure: { tone: "neg", label: "Needs HTTPS" },
};

export function NotificationsSection() {
  const { ui, msg, busy, enable, disable, test } = usePush();
  const b = ui ? PUSH_BADGE[ui.state] : null;
  return (
    <Section id="notifications" title="Notifications" badge={b ? <Badge tone={b.tone}>{b.label}</Badge> : undefined}>
      {!ui ? <div className="text-[14px] text-ink-3">Checking this device…</div> : (
        <div data-testid="push-control" data-state={ui.state}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-brand"><IconBell /></span>
            <div className="text-[15px] text-ink-2" data-testid="push-message">{ui.message}</div>
          </div>
          {ui.steps && <ol className="mt-3 list-decimal space-y-1 pl-9 text-[14px] text-ink-2" data-testid="push-steps">{ui.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
          {ui.state === "blocked" && <div className="mt-2 text-[13px] text-ink-3">After allowing notifications, reopen Copilot from your Home Screen and come back here.</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {ui.state === "can-enable" && <Button variant="primary" className="w-full" disabled={busy} onClick={() => void enable()} data-testid="push-enable">Enable notifications</Button>}
            {ui.state === "enabled" && (
              <>
                <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void test()} data-testid="push-test">Send test</Button>
                <Button className="flex-1" disabled={busy} onClick={() => void disable()}>Turn off</Button>
              </>
            )}
          </div>
          {msg && <div className="mt-2 text-[13px] text-ink-2" data-testid="push-result">{msg}</div>}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ theme

export type ThemeChoice = "system" | "dark" | "light";
const THEME_KEY = "fc:theme";
const themeListeners = new Set<() => void>();

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
}
/** Persists the choice and applies it to <html data-theme> at once ("system" removes the attribute so prefers-color-scheme decides). */
export function applyTheme(t: ThemeChoice) {
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked: still apply for this visit */
  }
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  themeListeners.forEach((l) => l());
}
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const t = useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        themeListeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    readTheme,
    () => "system" as ThemeChoice,
  );
  return [t, applyTheme];
}

export function ThemeControl() {
  const [theme, setTheme] = useTheme();
  return <Segmented<ThemeChoice> value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />;
}

// ------------------------------------------------------------------ league settings

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

/** Editable league settings. Mount with key={JSON.stringify(settings)} so it resets when the server values change. */
export function LeagueSettingsForm({ settings, onSave }: { settings: SeasonSettings; onSave: (patch: Partial<SeasonSettings>) => Promise<void> }) {
  const [f, setF] = useState({
    weeklyAddLimit: String(settings.weeklyAddLimit),
    ilSlots: String(settings.ilSlots),
    benchSlots: String(settings.benchSlots),
    playoffWeeks: String(settings.playoffWeeks),
    lineupLock: settings.lineupLock,
    timezone: settings.timezone,
    fetchFreeAgentPages: settings.fetchFreeAgentPages,
  });
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setMsg(null);
    setF((x) => ({ ...x, [k]: v }));
  };
  const valid = (["weeklyAddLimit", "ilSlots", "benchSlots", "playoffWeeks"] as const).every((k) => Number.isInteger(num(f[k])) && num(f[k]) >= 0) && f.timezone.trim() !== "";
  const dirty = num(f.weeklyAddLimit) !== settings.weeklyAddLimit || num(f.ilSlots) !== settings.ilSlots || num(f.benchSlots) !== settings.benchSlots || num(f.playoffWeeks) !== settings.playoffWeeks || f.lineupLock !== settings.lineupLock || f.timezone.trim() !== settings.timezone || f.fetchFreeAgentPages !== settings.fetchFreeAgentPages;

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ weeklyAddLimit: num(f.weeklyAddLimit), ilSlots: num(f.ilSlots), benchSlots: num(f.benchSlots), playoffWeeks: num(f.playoffWeeks), lineupLock: f.lineupLock, timezone: f.timezone.trim(), fetchFreeAgentPages: f.fetchFreeAgentPages });
      setMsg({ text: "Saved", ok: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally {
      setSaving(false);
    }
  };
  const field = "fc-num min-h-11 w-24 rounded-xl border border-rule bg-raised px-3 text-right text-[15px] text-ink";
  const numField = (k: "weeklyAddLimit" | "ilSlots" | "benchSlots" | "playoffWeeks", label: string, hint?: string) => (
    <label className="flex items-center justify-between gap-4 border-b border-rule py-2 last:border-b-0">
      <span><span className="block text-[15px] text-ink">{label}</span>{hint && <span className="block text-[12.5px] text-ink-3">{hint}</span>}</span>
      <input type="number" inputMode="numeric" min={0} value={f[k]} onChange={(e) => set(k, e.target.value)} className={field} data-testid={`setting-${k}`} />
    </label>
  );
  return (
    <div>
      {numField("weeklyAddLimit", "Weekly add limit", "Adds plus waiver claims")}
      {numField("ilSlots", "IL slots")}
      {numField("benchSlots", "Bench slots")}
      {numField("playoffWeeks", "Playoff weeks", "Planning only")}
      <div className="border-b border-rule py-2.5">
        <div className="mb-2 text-[15px] text-ink">Roster slots</div>
        <div className="flex flex-wrap gap-1.5" data-testid="roster-slots">{settings.rosterSlots.map((s, i) => <Badge key={`${s}${i}`}>{s}</Badge>)}</div>
        <div className="mt-1.5 text-[12.5px] text-ink-3">{settings.rosterSlots.length} active slots, read from Yahoo.</div>
      </div>
      <div className="border-b border-rule py-2.5">
        <div className="mb-2 text-[15px] text-ink">Lineup lock</div>
        <Segmented<"daily" | "weekly"> value={f.lineupLock} onChange={(v) => set("lineupLock", v)} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} />
      </div>
      <label className="flex items-center justify-between gap-4 border-b border-rule py-2">
        <span><span className="block text-[15px] text-ink">Timezone</span><span className="block text-[12.5px] text-ink-3">Its midnight rolls the game day (Yahoo uses Pacific)</span></span>
        <input value={f.timezone} onChange={(e) => set("timezone", e.target.value)} className="min-h-11 w-44 rounded-xl border border-rule bg-raised px-3 text-[14px] text-ink" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="setting-timezone" />
      </label>
      <label className="flex items-center justify-between gap-4 py-3">
        <span><span className="block text-[15px] text-ink">Read more free-agent pages</span><span className="block text-[12.5px] text-ink-3">The Yahoo reader fetches the next pages of the FA list</span></span>
        <input type="checkbox" checked={f.fetchFreeAgentPages} onChange={(e) => set("fetchFreeAgentPages", e.target.checked)} className="h-6 w-6 accent-brand" data-testid="setting-fetchFreeAgentPages" />
      </label>
      <Button variant="primary" className="mt-1 w-full" disabled={!dirty || !valid || saving} onClick={() => void save()} data-testid="setting-save">{saving ? "Saving…" : "Save league settings"}</Button>
      {msg && <div className={cx("mt-2 text-[13px]", msg.ok ? "text-pos" : "text-neg")} role="status">{msg.text}</div>}
    </div>
  );
}
