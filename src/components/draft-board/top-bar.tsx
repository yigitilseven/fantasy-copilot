"use client";

import { PushBell } from "@/components/push-control";
import { useState } from "react";
import { leagueConfig } from "@/config/default-league";
import { useDraftStore, type BotSpeed } from "@/store/draft-store";
import { RISK_PRESETS, objectiveModeOf, projectionModeOf, projectionWeightOf, riskPresetOf, robustnessModeOf, type RiskPreset, type RobustnessMode, type StrategyPreset } from "@/engine/recommendation/strategy";
import { PROJECTION_WEIGHT_OPTIONS } from "@/engine/projection/blend";
import { TeamOutlookButton } from "./team-outlook";
import type { DraftDerived } from "@/store/derived";
import { useYahooStore } from "@/store/yahoo-store";
import { useBrowserSyncStore } from "@/store/browser-sync-store";
import { OBJECTIVE_LABELS, OBJECTIVE_MODES, type ObjectiveMode } from "@/engine/standings-opt/objective";
import { PredraftChip } from "./predraft-checklist";
import { NewsControl } from "./news-control";
import { ProjectionsControl } from "./projections-control";
import { BrowserSyncControl } from "./browser-sync-control";
import { YahooControl } from "./yahoo-control";

const PRESET_LABELS: Record<StrategyPreset, string> = {
  balanced: "Balanced", "punt-ft": "Punt FT%", "punt-fg": "Punt FG%", "punt-to": "Punt TO", "punt-ast": "Punt AST",
  "punt-3pm": "Punt 3PM", "punt-pts": "Punt PTS", custom: "Custom",
};
const RISK_LABELS: Record<RiskPreset, string> = { conservative: "Conservative", balanced: "Balanced", aggressive: "Aggressive" };

function StrategyControl() {
  const strategy = useDraftStore((s) => s.draft?.strategy);
  const setStrategy = useDraftStore((s) => s.setStrategy);
  const preset = strategy?.preset ?? "balanced";
  const risk = strategy?.riskTolerance ?? RISK_PRESETS.conservative;
  const rp = riskPresetOf(risk);
  const weight = projectionWeightOf(strategy);
  const mixAuto = projectionModeOf(strategy) === "auto";
  const robustMode = robustnessModeOf(strategy);
  const cls = "rounded-md bg-raised px-1 py-0.5 text-[11px]";
  const objective = objectiveModeOf(strategy);
  return (
    <div className="flex items-center gap-1" title="Draft strategy: drives recommendations in the app and the Yahoo overlay">
      <span className="text-ink-3">Strategy</span>
      <select
        data-testid="strategy-preset"
        aria-label="Strategy"
        value={preset}
        onChange={(e) => void setStrategy({ preset: e.target.value as StrategyPreset })}
        className={cls}
      >
        {(Object.keys(PRESET_LABELS) as StrategyPreset[]).map((p) => (
          <option key={p} value={p} disabled={p === "custom" && preset !== "custom"}>{PRESET_LABELS[p]}</option>
        ))}
      </select>
      <select
        data-testid="strategy-risk"
        aria-label="Risk tolerance"
        value={rp.exact ? rp.name : "custom"}
        onChange={(e) => {
          if (e.target.value in RISK_PRESETS) void setStrategy({ riskTolerance: RISK_PRESETS[e.target.value as RiskPreset] });
        }}
        className={cls}
      >
        {(Object.keys(RISK_LABELS) as RiskPreset[]).map((k) => (
          <option key={k} value={k}>{RISK_LABELS[k]}</option>
        ))}
        {!rp.exact && <option value="custom" disabled>{`Custom (${risk})`}</option>}
      </select>
      <select
        data-testid="strategy-objective"
        aria-label="Objective"
        value={objective}
        onChange={(e) => void setStrategy({ objective: e.target.value as ObjectiveMode })}
        className={cls}
        title="What the standings engine optimizes. H2H weekly wins: expected matchup wins vs the 13 opponents' projected final rosters (win >= 5 of 9 categories per week), roto top-5 as tiebreak. Robust top-5 roto: expected roto points with the worst Yahoo view prioritized. Max total roto: roto points. Classic: z-score ranking only (no standings model)."
      >
        {OBJECTIVE_MODES.map((m) => (
          <option key={m} value={m}>{`Objective: ${OBJECTIVE_LABELS[m]}`}</option>
        ))}
      </select>
      <span className="ml-1 text-ink-3" title="Projection mix: how Yahoo's 2026-27 projection (+ FantasyPros when cached) and real 2025-26 production are combined in every player's line">Mix</span>
      <select
        data-testid="strategy-projection-mix"
        aria-label="Projection mix"
        value={mixAuto ? "auto" : String(weight)}
        onChange={(e) => void setStrategy(e.target.value === "auto" ? { projectionMode: "auto" } : { projectionWeight: Number(e.target.value) })}
        className={cls}
        title="Auto: per-player weights (rates per 36 min and volume blended separately; rookies, team changes and injury returns lean on the projection, stable veterans on real stats). Fixed: one Yahoo / 2025-26 split for everybody."
      >
        <option value="auto">Auto (per player)</option>
        {PROJECTION_WEIGHT_OPTIONS.map((w) => (
          <option key={w} value={String(w)}>{w === 1 ? "Yahoo 100%" : w === 0 ? "2025-26 100%" : `Yahoo ${Math.round(w * 100)}% / 25-26 ${Math.round((1 - w) * 100)}%`}</option>
        ))}
        {!mixAuto && !(PROJECTION_WEIGHT_OPTIONS as readonly number[]).includes(weight) && <option value={String(weight)} disabled>{`Yahoo ${Math.round(weight * 100)}%`}</option>}
      </select>
      <select
        data-testid="strategy-robust"
        aria-label="Source disagreement"
        value={robustMode}
        onChange={(e) => void setStrategy({ robustnessMode: e.target.value as RobustnessMode })}
        className={cls}
        title="Players whose Yahoo projection and 2025-26 stats disagree. Auto: small penalty in rounds 1-6, upside bonus from round 10 (interpolated in between). Always: penalty in every round. Never: off."
      >
        <option value="auto">Disagreement: auto</option>
        <option value="always">Disagreement: penalize</option>
        <option value="never">Disagreement: ignore</option>
      </select>
    </div>
  );
}

/** Projected finish + weekly H2H outlook (from the standings analysis of the current roster + the expected rest of the draft). */
function StandingsStrip() {
  const st = useDraftStore((s) => s.standings);
  const o = st?.outlook;
  if (!o) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cats = Object.entries(o.h2h.catP);
  return (
    <div data-testid="standings-strip" className="flex h-6 shrink-0 items-center gap-4 border-b border-rule bg-panel px-3 text-[11px]">
      <span data-testid="weekly-outlook" className="font-semibold text-ink" title={`Average weekly matchup win probability ${pct(o.h2h.winProb)} (worst view ${pct(o.h2h.minWinProb)}); ${o.sims} simulated draft completions`}>
        {o.weeklyLine}
      </span>
      <span data-testid="projected-finish" className="text-ink" title="Roto rank in Yahoo's three standings views (2026-27 projected totals, 2025-26 totals, 2025-26 averages), current roster + expected rest of the draft">
        {o.finishLine}
      </span>
      <span data-testid="core-cats" className="flex items-center gap-1" title="Green: core categories (P(win) >= 60% vs a typical opponent). Grey: out of reach (< 30%).">
        {cats.map(([c, p]) => (
          <span
            key={c}
            data-core={o.h2h.core.includes(c) ? "core" : o.h2h.punted.includes(c) ? "punted" : "swing"}
            title={`${c}: ${pct(p)} weekly win chance`}
            className={`rounded-md px-1 py-px text-[10px] font-semibold ${o.h2h.core.includes(c) ? "bg-pos-bg text-pos" : o.h2h.punted.includes(c) ? "bg-raised text-ink-3 line-through" : "bg-raised text-ink"}`}
          >
            {c}
          </span>
        ))}
      </span>
    </div>
  );
}

export function TopBar({ derived }: { derived: DraftDerived }) {
  const draft = useDraftStore((s) => s.draft)!;
  const simStatus = useDraftStore((s) => s.simStatus);
  const simInfo = useDraftStore((s) => s.simInfo);
  const busy = useDraftStore((s) => s.busy);
  const undo = useDraftStore((s) => s.undo);
  const newDraft = useDraftStore((s) => s.newDraft);
  const newMockDraft = useDraftStore((s) => s.newMockDraft);
  const mode = useDraftStore((s) => s.mode);
  const setMode = useDraftStore((s) => s.setMode);
  const botSpeed = useDraftStore((s) => s.botSpeed);
  const setBotSpeed = useDraftStore((s) => s.setBotSpeed);
  const botsPaused = useDraftStore((s) => s.botsPaused);
  const simToMyPick = useDraftStore((s) => s.simToMyPick);
  const yahooLive = useYahooStore((s) => s.liveSync);
  const browserSync = useBrowserSyncStore((s) => s.enabled);
  /** Yahoo live sync and Browser sync both drive the board from outside: bots are locked out while either is on. */
  const liveSync = yahooLive || browserSync;
  const [form, setForm] = useState<{ userSlot: number; teams: number; rounds: number } | null>(null);

  let sim = "sim idle";
  if (simStatus === "running") sim = "simulating…";
  else if (simStatus === "error") sim = "sim failed — raw rankings";
  else if (simInfo) sim = `sim ${Math.round(simInfo.simulations / 1000)}k · ${Math.round(simInfo.elapsedMs)}ms`;

  const mine = derived.userRosterIds.length;
  return (
    <>
    <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule bg-panel px-3 py-1 pt-[max(0.25rem,env(safe-area-inset-top))] text-xs md:gap-x-6 md:py-1">
      {derived.complete ? (
        <span data-testid="current-pick" className="font-bold text-pos">DRAFT COMPLETE</span>
      ) : (
        <span className="font-bold">
          PICK <span data-testid="current-pick">{derived.currentPick}</span>
          <span className="ml-2 font-normal">
            {derived.isUserOnClock ? (
              <span data-testid="on-clock" className="rounded-md bg-pos px-1.5 py-px font-bold text-canvas">YOUR PICK</span>
            ) : (
              <span data-testid="on-clock" className="text-ink-2">team {derived.onClockSlot} on the clock</span>
            )}
          </span>
        </span>
      )}
      <span className="text-ink-2">
        NEXT: <span data-testid="next-pick" className="font-semibold text-ink">
          {derived.survivalTarget ?? "–"}
        </span>
      </span>
      <span className="text-ink-2">
        MY TEAM: <span data-testid="my-team" className="font-semibold text-ink">{mine}/{draft.rounds}</span>
      </span>
      <span
        data-testid="sim-status"
        className={simStatus === "error" ? "text-warn" : simStatus === "running" ? "text-brand" : "text-ink-3"}
      >
        {sim}
      </span>
      {mode === "mock" && !derived.complete && !derived.isUserOnClock && (
        <span data-testid="bots-status" className={botsPaused ? "text-warn" : "text-brand"}>
          {botsPaused ? "Bots paused" : "Bots picking…"}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2 md:ml-auto">
        <PushBell />
        <PredraftChip derived={derived} />
        <ProjectionsControl />
        <NewsControl />
        <StrategyControl />
        <TeamOutlookButton />
        <BrowserSyncControl />
        <YahooControl />
        <a href="/history" data-testid="history-link" className="rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-ink hover:bg-track" title="Past drafts, opponents and model calibration">History</a>
        <a href="/today" data-testid="season-link" className="rounded-md bg-pos-bg px-1.5 py-0.5 text-[11px] text-pos " title="Season mode: daily start/sit and add/drop suggestions">Season</a>
        <div role="group" aria-label="Draft mode" className="flex overflow-hidden rounded-md border border-rule text-[11px]">
          {(["manual", "mock"] as const).map((m) => (
            <button
              key={m}
              data-testid={`mode-${m}`}
              aria-pressed={mode === m}
              disabled={liveSync && m === "mock"}
              title={liveSync && m === "mock" ? "Turn off Yahoo live sync / Browser sync to use bots" : undefined}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40 ${mode === m ? "bg-brand font-semibold text-brand-ink" : "bg-raised text-ink-2 hover:bg-track"}`}
            >
              {m === "manual" ? "Manual" : "Mock vs bots"}
            </button>
          ))}
        </div>
        {mode === "mock" && (
          <select
            data-testid="bot-speed"
            aria-label="Bot speed"
            value={botSpeed}
            onChange={(e) => setBotSpeed(e.target.value as BotSpeed)}
            className="rounded-md bg-raised px-1 py-0.5 text-[11px]"
          >
            <option value="instant">Instant</option>
            <option value="fast">0.6s</option>
            <option value="slow">2s</option>
          </select>
        )}
        <button
          data-testid="sim-to-pick"
          disabled={busy || derived.complete || derived.isUserOnClock || liveSync}
          title={liveSync ? "Disabled while following Yahoo: picks come from the draft room" : undefined}
          onClick={() => void simToMyPick()}
          className="rounded-md bg-raised px-2 py-0.5 text-[11px] font-semibold hover:bg-track disabled:opacity-40"
        >
          SIM TO MY PICK
        </button>
        <button
          data-testid="undo-button"
          disabled={busy || draft.picks.length === 0}
          onClick={() => void undo()}
          className="rounded-md bg-raised px-2 py-0.5 text-[11px] font-semibold hover:bg-track disabled:opacity-40"
        >
          UNDO (U)
        </button>
        <button
          data-testid="new-draft-button"
          disabled={busy}
          onClick={() => {
            if (confirm("Start a new draft? The current draft stays saved but will no longer be the active one.")) void newDraft();
          }}
          className="rounded-md bg-raised px-2 py-0.5 text-[11px] hover:bg-track disabled:opacity-40"
        >
          NEW DRAFT
        </button>
        <div className="relative">
          <button
            data-testid="new-mock-button"
            disabled={busy || liveSync}
            onClick={() => setForm(form ? null : { userSlot: leagueConfig.userSlot, teams: leagueConfig.teams, rounds: leagueConfig.rounds })}
            className="rounded-md bg-brand text-brand-ink px-2 py-0.5 text-[11px] font-semibold hover:brightness-110 disabled:opacity-40"
          >
            NEW MOCK
          </button>
          {form && (
            <form
              data-testid="new-mock-form"
              className="absolute right-0 top-7 z-20 flex w-56 flex-col gap-1.5 rounded-md border border-rule bg-panel p-2 text-[11px] shadow-lg"
              onSubmit={(e) => {
                e.preventDefault();
                const teams = Math.min(16, Math.max(8, form.teams || 8));
                const userSlot = Math.min(teams, Math.max(1, form.userSlot || 1));
                setForm(null);
                void newMockDraft({ userSlot, teams, rounds: Math.max(1, form.rounds || 1) });
              }}
            >
              {([["userSlot", "My slot", 1, 16], ["teams", "Teams", 8, 16], ["rounds", "Rounds", 1, 20]] as const).map(([k, label, min, max]) => (
                <label key={k} className="flex items-center justify-between gap-2">
                  {label}
                  <input
                    data-testid={`mock-${k}`}
                    type="number"
                    min={min}
                    max={max}
                    value={Number.isNaN(form[k]) ? "" : form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.valueAsNumber })}
                    className="w-16 rounded-md bg-raised px-1 py-0.5 text-right"
                  />
                </label>
              ))}
              <div className="flex justify-end gap-1.5">
                <button type="button" onClick={() => setForm(null)} className="rounded-md bg-raised px-2 py-0.5">Cancel</button>
                <button data-testid="mock-start" type="submit" className="rounded-md bg-brand px-2 py-0.5 font-semibold text-brand-ink">Start</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </header>
    <StandingsStrip />
    </>
  );
}
