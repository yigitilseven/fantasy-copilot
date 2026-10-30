"use client";

import { useState } from "react";
import { ago } from "@/ui/format";
import { Badge, Button, Card, ErrorBar, LinkButton, PageTitle, Skeleton } from "@/ui/kit";
import { IconArrow, IconExternal } from "@/ui/icons";
import { useSeason } from "@/ui/season-data";
import { FreshnessList, InfoRow, LeagueSettingsForm, NotificationsSection, RemoteBrowserCard, Section, SyncParts, ThemeControl, useWorkerStatus } from "@/ui/settings-parts";

const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "n/a");

export default function SettingsPage() {
  const { data: d, error, sync, busy, notice, dismissNotice, refreshAll, saveSettings, reload } = useSeason();
  const [workerKey, setWorkerKey] = useState(0);
  const worker = useWorkerStatus(workerKey);

  if (!d) return <div className="mx-auto max-w-xl">{error ? <ErrorBar message={error.message} onRetry={reload} /> : <Skeleton lines={4} label="Loading settings…" />}</div>;

  const s = d.league.settings;
  const lastAttempt = sync?.lastAttemptAt ?? null;
  const syncOk = sync ? Object.values(sync.parts).every((p) => p.ok) : null;
  const refresh = async () => {
    await refreshAll();
    setWorkerKey((k) => k + 1);
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-6">
      <PageTitle title="Settings" meta={d.league.name} />

      <Section id="data" title="Data & sync" badge={syncOk == null ? undefined : <Badge tone={syncOk ? "neutral" : "warn"}>{syncOk ? "Success" : "Partial"}</Badge>}>
        <FreshnessList d={d} sync={sync} />
        <div className="mt-3 border-t border-rule pt-3">
          <div className="text-[16px] text-ink">{lastAttempt ? `Last sync ${ago(lastAttempt)} · ${hhmm(lastAttempt)}` : "No Yahoo sync yet"}</div>
          <div className="mt-1 text-[14px] text-ink-2">{worker?.available && worker.nextRunAt ? `Next sync ${hhmm(worker.nextRunAt)} · about every 2 h` : "The browser worker syncs about every 2 h."}</div>
          <Button variant="primary" className="mt-3 w-full" disabled={!!busy} onClick={() => void refresh()} data-testid="refresh-data">{busy ?? "Refresh data"}</Button>
          {notice && (
            <div className="mt-2 flex items-start justify-between gap-3 text-[13px] text-ink-2" role="status">
              <span>{notice}</span>
              <button onClick={dismissNotice} className="shrink-0 text-brand">Dismiss</button>
            </div>
          )}
        </div>
        {sync && (
          <details className="mt-3 border-t border-rule pt-3">
            <summary className="cursor-pointer text-[14px] text-ink-2">Sync details · teams {sync.teamsSynced}/{sync.teamsTotal} · {sync.requests} requests</summary>
            <SyncParts sync={sync} />
          </details>
        )}
        <p className="mt-3 text-[12.5px] text-ink-3">Neutral age labels mean healthy data. Amber means stale; red means a failed source. Cached advice stays visible with its age.</p>
      </Section>

      <RemoteBrowserCard w={worker} />

      <NotificationsSection />

      <Section id="preferences" title="Preferences">
        <div className="mb-1 text-[15px] text-ink">Theme</div>
        <ThemeControl />
        <div className="mt-4">
          <InfoRow label="Morning brief" value="BRIEF_TIME" hint="Set on the server" />
          <InfoRow label="Weekly plan" value="WEEKLY_PLAN_DAY" hint="Set on the server" />
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">The morning brief time and the weekly plan day are server settings (BRIEF_TIME and WEEKLY_PLAN_DAY in the VPS .env). Change them there and restart the app; they cannot be changed from this screen.</p>
      </Section>

      <Section id="league" title={d.league.name}>
        <div className="mb-3 text-[14px] text-ink-2">{d.league.teams} teams · H2H · 9 categories · {s.weeklyAddLimit} adds / week · {s.ilSlots} IL · {s.rosterSlots.length} active slots</div>
        <LeagueSettingsForm key={JSON.stringify(s)} settings={s} onSave={saveSettings} />
      </Section>

      <div className="grid grid-cols-2 gap-3">
        <LinkButton href="/draft">Draft room <IconExternal /></LinkButton>
        <LinkButton href="/history">Draft history <IconArrow /></LinkButton>
      </div>
      <Card className="p-4 text-[12.5px] text-ink-3">Yahoo is read only: Copilot never writes to your Yahoo account.</Card>
    </div>
  );
}
