"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* Draft history: past drafts, board grid, standings, opponent behaviour and model calibration. Desktop, dense, CSS-only charts. */

type Kind = "yahoo-live" | "mock-bots" | "manual" | "damaged";
interface Summary {
  id: number; createdAt: string; teams: number; rounds: number; userSlot: number; status: string; picks: number; kind: Kind;
  leagueName: string | null; finishedAt: string | null; userTeam: string | null; ranks: Record<string, { rank: number; total: number | null }>;
}
interface PickRow {
  pick: number; round: number; teamSlot: number; teamName: string; playerId: string; name: string; positions: string; nbaTeam: string;
  adp: number | null; deviation: number | null; z: number | null; isUser: boolean;
}
interface StandingRow { view: string; teamName: string; rank: number; fg: number | null; ft: number | null; threePm: number | null; pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null; tov: number | null; total: number | null }
interface Detail { summary: Summary; teams: { slot: number; name: string; isUser: boolean }[]; picks: PickRow[]; standings: StandingRow[] }
interface Bucket { lo: number; hi: number; n: number; meanPredicted: number; observedRate: number }
interface Analysis {
  draftIds: number[];
  reach: { n: number; byRound: { round: number; n: number; mean: number; sd: number; withinSigma: number }[]; withinSigma: number; reaches: Dev[]; steals: Dev[] };
  runs: { draftId: number; windows: number; flagged: number; byRound: { round: number; windows: number; flagged: number; rate: number }[]; byPosition: Record<string, number> }[];
  autopick: { draftId: number; byTeam: { teamSlot: number; teamName: string; isUser: boolean; picks: number; adpTop: number; share: number; flagged: boolean }[] }[];
  managers: { name: string; drafts: number; picks: number; avgDeviation: number; sdDeviation: number; autopickShare: number; positions: Record<string, number>; topPosition: string | null }[];
  calibration: { n: number; brier: number; reliability: Bucket[]; perDraft: { draftId: number; n: number; brier: number }[] };
  model: StoredModel | null;
}
interface Dev { draftId: number; pick: number; name: string; adp: number; deviation: number; teamName: string }
interface StoredModel { k: number; autopickShare: number; enabled: boolean; fittedAt: string; detail?: { n?: number; logLik?: number; logLikDefault?: number; draftIds?: number[]; surface?: { k: number; logLik: number; logLikNoAuto: number }[] } }

const KIND_STYLE: Record<Kind, string> = {
  "yahoo-live": "bg-pos-bg text-pos", "mock-bots": "bg-brand-bg text-brand", manual: "bg-raised text-ink", damaged: "bg-neg-bg text-neg",
};
const VIEW_LABEL: Record<string, string> = { "proj-2026-27": "2026-27 Proj Stats", "total-2025-26": "2025-26 Total Stats", "avg-2025-26": "2025-26 Average Stats" };
const f = (x: number | null | undefined, d = 1) => (x == null ? "-" : x.toFixed(d));
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return (await r.json()) as T;
}

export default function HistoryPage() {
  const [drafts, setDrafts] = useState<Summary[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"board" | "roster" | "standings" | "opponents" | "model">("board");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ drafts: Summary[] }>("/api/history/drafts")
      .then((r) => {
        setDrafts(r.drafts);
        setSel((cur) => cur ?? r.drafts.find((d) => d.kind === "yahoo-live" && d.picks > 100)?.id ?? r.drafts[0]?.id ?? null);
      })
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(() => {
    if (sel === null) return;
    getJson<Detail>(`/api/history/drafts/${sel}`).then(setDetail).catch((e) => setErr(String(e.message ?? e)));
  }, [sel]);
  const shown = detail && detail.summary.id === sel ? detail : null;
  const loadAnalysis = useCallback(() => {
    setBusy("Analysing drafts…");
    getJson<Analysis>("/api/history/analysis")
      .then(setAnalysis)
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(null));
  }, []);
  const openTab = (k: typeof tab) => {
    setTab(k);
    if ((k === "opponents" || k === "model") && !analysis && !busy) loadAnalysis();
  };

  const modelAction = async (body: { refit?: boolean; enabled?: boolean }) => {
    setBusy(body.refit ? "Fitting model (a few seconds)…" : "Saving…");
    try {
      await getJson("/api/history/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setAnalysis(null);
      loadAnalysis();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const TABS: [typeof tab, string][] = [["board", "Board"], ["roster", "Your roster"], ["standings", "Standings"], ["opponents", "Opponents"], ["model", "Model"]];
  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-[12px] text-ink md:h-screen" data-testid="history-page">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-4 py-3 md:py-2">
        <a href="/draft" className="text-brand hover:underline">&larr; Draft</a>
        <h1 className="text-[22px] font-normal tracking-tight md:text-base">Draft history</h1>
        <span className="text-ink-3">Analytics run on clean yahoo-live drafts only (mock, manual and damaged drafts are excluded).</span>
        {busy && <span className="ml-auto text-brand">{busy}</span>}
        {err && (
          <button className="ml-auto text-neg" onClick={() => setErr(null)} title="dismiss">{err}</button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">        <aside className="max-h-[40vh] w-full shrink-0 overflow-y-auto border-b border-rule md:max-h-none md:w-[330px] md:border-b-0 md:border-r">
          <table className="w-full text-[11px]" data-testid="history-drafts">
            <thead className="sticky top-0 bg-panel text-ink-3">
              <tr><th className="px-1.5 py-1 text-left">#</th><th className="text-left">Date</th><th className="text-left">Kind</th><th>Slot</th><th>Picks</th><th className="text-left">Your rank (proj / total / avg)</th></tr>
            </thead>
            <tbody>
              {(drafts ?? []).map((d) => (
                <tr key={d.id} onClick={() => setSel(d.id)} className={`cursor-pointer border-t border-rule hover:bg-panel ${sel === d.id ? "bg-raised" : ""}`}>
                  <td className="px-1.5 py-1 text-ink-2">{d.id}</td>
                  <td>{d.createdAt.slice(0, 10)}</td>
                  <td><span className={`rounded px-1 ${KIND_STYLE[d.kind]}`}>{d.kind}</span></td>
                  <td className="text-center">{d.userSlot}</td>
                  <td className="text-center">{d.picks}/{d.teams * d.rounds}</td>
                  <td className="whitespace-nowrap text-ink">
                    {["proj-2026-27", "total-2025-26", "avg-2025-26"].map((v) => (d.ranks[v] ? `#${d.ranks[v].rank}` : "-")).join(" / ")}
                  </td>
                </tr>
              ))}
              {drafts && !drafts.length && <tr><td colSpan={6} className="p-3 text-ink-3">No drafts yet.</td></tr>}
            </tbody>
          </table>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
          <nav className="flex gap-1 overflow-x-auto border-b border-rule px-2 pt-1 whitespace-nowrap" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} data-testid={`history-tab-${k}`} onClick={() => openTab(k)}
                className={`rounded-t px-3 py-1 ${tab === k ? "bg-raised font-semibold text-ink" : "text-ink-2 hover:bg-panel"}`}>{label}</button>
            ))}
            {shown && <span className="ml-auto hidden px-2 py-1 text-ink-3 md:inline">Draft #{shown.summary.id} · {shown.summary.leagueName ?? "league ?"} · {shown.summary.userTeam ?? "your team ?"}</span>}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {tab === "board" && (shown ? <BoardGrid d={shown} /> : <Loading />)}
            {tab === "roster" && (shown ? <Roster d={shown} /> : <Loading />)}
            {tab === "standings" && (shown ? <Standings d={shown} /> : <Loading />)}
            {tab === "opponents" && (analysis ? <Opponents a={analysis} selected={sel} /> : <Loading />)}
            {tab === "model" && (analysis ? <ModelTab a={analysis} act={modelAction} busy={!!busy} /> : <Loading />)}
          </div>
        </section>
      </div>
    </main>
  );
}

const Loading = () => <div className="p-4 text-ink-3">Loading…</div>;

// ------------------------------------------------------------------------------------------------ board

function cellStyle(z: number | null): React.CSSProperties {
  if (z == null) return {};
  const a = Math.min(0.55, Math.abs(z) * 0.18);
  if (z <= -1) return { background: `color-mix(in srgb, var(--fc-neg) ${Math.round(a*100)}%, transparent)` }; // reach: taken earlier than ADP
  if (z >= 1) return { background: `color-mix(in srgb, var(--fc-pos) ${Math.round(a*100)}%, transparent)` }; // steal / fall
  return {};
}

function BoardGrid({ d }: { d: Detail }) {
  const rounds = d.summary.rounds;
  const grid = useMemo(() => {
    const m = new Map<string, PickRow>();
    for (const p of d.picks) m.set(`${p.round}:${p.teamSlot}`, p);
    return m;
  }, [d.picks]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-3 text-ink-3">
        <span>Rounds × teams, your column highlighted.</span>
        <span className="rounded px-1" style={{ background: "color-mix(in srgb, var(--fc-neg) 40%, transparent)" }}>reach (taken ≥1σ before ADP)</span>
        <span className="rounded px-1" style={{ background: "color-mix(in srgb, var(--fc-pos) 40%, transparent)" }}>steal (fell ≥1σ past ADP)</span>
      </div>
      <table className="border-collapse text-[10px]" data-testid="history-board">
        <thead>
          <tr>
            <th className="sticky left-0 bg-canvas px-1 text-ink-3">Rd</th>
            {d.teams.map((t) => (
              <th key={t.slot} className={`min-w-[96px] max-w-[110px] truncate px-1 py-0.5 ${t.isUser ? "bg-brand-bg text-brand" : "text-ink-2"}`} title={t.name}>{t.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rounds }, (_, r) => r + 1).map((r) => (
            <tr key={r}>
              <td className="sticky left-0 bg-canvas px-1 text-center text-ink-3">{r}</td>
              {d.teams.map((t) => {
                const p = grid.get(`${r}:${t.slot}`);
                return (
                  <td key={t.slot} className={`h-[34px] border border-rule px-1 align-top ${t.isUser ? "outline outline-1 -outline-offset-1 outline-brand" : ""}`} style={cellStyle(p?.z ?? null)}
                    title={p ? `#${p.pick} ${p.name} (${p.positions}, ${p.nbaTeam}) ADP ${f(p.adp)}  Δ ${f(p.deviation, 0)}` : undefined}>
                    {p && (
                      <>
                        <div className="truncate leading-tight text-ink">{p.name}</div>
                        <div className="flex justify-between leading-tight text-ink-3"><span>{p.positions}</span><span>#{p.pick}{p.deviation != null ? ` ${p.deviation > 0 ? "+" : ""}${p.deviation.toFixed(0)}` : ""}</span></div>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Roster({ d }: { d: Detail }) {
  const mine = d.picks.filter((p) => p.isUser);
  return (
    <div>
      <div className="mb-1 text-ink-2">{mine.length} players · {d.summary.userTeam ?? "your team"}</div>
      <table className="text-[11px]" data-testid="history-roster">
        <thead className="text-ink-3"><tr><th className="px-2 text-left">Rd</th><th className="px-2 text-left">Pick</th><th className="px-2 text-left">Player</th><th className="px-2 text-left">Pos</th><th className="px-2 text-left">Team</th><th className="px-2 text-right">ADP</th><th className="px-2 text-right">Pick − ADP</th></tr></thead>
        <tbody>
          {mine.map((p) => (
            <tr key={p.pick} className="border-t border-rule">
              <td className="px-2">{p.round}</td><td className="px-2">{p.pick}</td><td className="px-2 text-ink">{p.name}</td><td className="px-2">{p.positions}</td><td className="px-2">{p.nbaTeam}</td>
              <td className="px-2 text-right">{f(p.adp)}</td>
              <td className={`px-2 text-right ${p.deviation == null ? "" : p.deviation < -2 ? "text-neg" : p.deviation > 2 ? "text-pos" : ""}`}>{p.deviation == null ? "-" : (p.deviation > 0 ? "+" : "") + p.deviation.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Standings({ d }: { d: Detail }) {
  const views = [...new Set(d.standings.map((s) => s.view))];
  if (!views.length) return <div className="p-4 text-ink-3">No standings captured for this draft. Open the Standings tab in the Yahoo draft room after &quot;Draft Complete&quot; (the userscript sends it), or run <code>pnpm history:import-snapshots --draft={d.summary.id}</code>.</div>;
  return (
    <div className="flex flex-col gap-4">
      {views.map((v) => (
        <div key={v}>
          <div className="mb-1 font-semibold text-ink">{VIEW_LABEL[v] ?? v}</div>
          <table className="text-[11px]" data-testid={`history-standings-${v}`}>
            <thead className="text-ink-3"><tr>{["Rank", "Team", "FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO", "Total"].map((h, i) => <th key={h} className={`px-2 ${i === 1 ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
            <tbody>
              {d.standings.filter((s) => s.view === v).map((s) => (
                <tr key={s.teamName} className={`border-t border-rule ${s.teamName === d.summary.userTeam ? "bg-brand-bg font-semibold text-brand" : ""}`}>
                  <td className="px-2 text-right">{s.rank}</td><td className="px-2">{s.teamName}</td>
                  <td className="px-2 text-right">{f(s.fg, 3)}</td><td className="px-2 text-right">{f(s.ft, 3)}</td>
                  {[s.threePm, s.pts, s.reb, s.ast, s.stl, s.blk, s.tov].map((x, i) => <td key={i} className="px-2 text-right">{x == null ? "-" : v === "avg-2025-26" ? x.toFixed(1) : Math.round(x)}</td>)}
                  <td className="px-2 text-right">{f(s.total, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ opponents

function Bar({ value, max, color = "bg-brand", center = false }: { value: number; max: number; color?: string; center?: boolean }) {
  const w = Math.min(100, (Math.abs(value) / (max || 1)) * (center ? 50 : 100));
  return (
    <div className="relative h-2 w-28 rounded-sm bg-panel">
      {center ? (
        <div className={`absolute top-0 h-2 ${value < 0 ? "bg-neg" : "bg-pos"}`} style={{ width: `${w}%`, left: value < 0 ? `${50 - w}%` : "50%" }} />
      ) : (
        <div className={`h-2 rounded-sm ${color}`} style={{ width: `${w}%` }} />
      )}
    </div>
  );
}

function Opponents({ a, selected }: { a: Analysis; selected: number | null }) {
  if (!a.draftIds.length) return <div className="p-4 text-ink-3">No clean yahoo-live drafts yet.</div>;
  const auto = a.autopick.find((x) => x.draftId === selected) ?? a.autopick[a.autopick.length - 1];
  const maxDev = Math.max(5, ...a.reach.byRound.map((r) => Math.abs(r.mean)));
  return (
    <div className="flex flex-col gap-5">
      <div className="text-ink-2">Drafts analysed: {a.draftIds.map((i) => `#${i}`).join(", ")} · {a.reach.n} picks with a market ADP (≤ 300). Within-σ share overall: <b className="text-ink">{pct(a.reach.withinSigma)}</b> (a calibrated model gives ~68%).</div>

      <div>
        <div className="mb-1 font-semibold">Pick − ADP by round (negative = reach)</div>
        <table className="text-[11px]" data-testid="history-rounds">
          <thead className="text-ink-3"><tr><th className="px-2 text-right">Rd</th><th className="px-2 text-right">n</th><th className="px-2 text-right">mean</th><th className="px-2 text-left">reach ← → fall</th><th className="px-2 text-right">sd</th><th className="px-2 text-right">within ±1σ</th><th className="px-2 text-left" /></tr></thead>
          <tbody>
            {a.reach.byRound.map((r) => (
              <tr key={r.round} className="border-t border-rule">
                <td className="px-2 text-right">{r.round}</td><td className="px-2 text-right">{r.n}</td>
                <td className={`px-2 text-right ${r.mean < -3 ? "text-neg" : r.mean > 3 ? "text-pos" : ""}`}>{f(r.mean, 2)}</td>
                <td className="px-2"><Bar value={r.mean} max={maxDev} center /></td>
                <td className="px-2 text-right">{f(r.sd, 1)}</td><td className="px-2 text-right">{pct(r.withinSigma)}</td>
                <td className="px-2"><Bar value={r.withinSigma} max={1} color="bg-ink-3" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <DevList title="Biggest reaches" rows={a.reach.reaches} />
        <DevList title="Biggest steals" rows={a.reach.steals} />
      </div>

      <div>
        <div className="mb-1 font-semibold">Per manager (by Yahoo team name, across drafts)</div>
        <table className="text-[11px]" data-testid="history-managers">
          <thead className="text-ink-3"><tr><th className="px-2 text-left">Manager</th><th className="px-2 text-right">Drafts</th><th className="px-2 text-right">Picks</th><th className="px-2 text-right">Avg Δ</th><th className="px-2 text-right">sd</th><th className="px-2 text-left">Autopick-like</th><th className="px-2 text-left">Positions</th></tr></thead>
          <tbody>
            {a.managers.map((m) => (
              <tr key={m.name} className="border-t border-rule">
                <td className="px-2 text-ink">{m.name}</td><td className="px-2 text-right">{m.drafts}</td><td className="px-2 text-right">{m.picks}</td>
                <td className={`px-2 text-right ${m.avgDeviation < -3 ? "text-neg" : m.avgDeviation > 3 ? "text-pos" : ""}`}>{f(m.avgDeviation, 1)}</td><td className="px-2 text-right">{f(m.sdDeviation, 1)}</td>
                <td className="px-2"><div className="flex items-center gap-1"><Bar value={m.autopickShare} max={1} color={m.autopickShare >= 0.6 ? "bg-warn" : "bg-brand"} /><span>{pct(m.autopickShare)}</span></div></td>
                <td className="px-2"><div className="flex gap-0.5">{(["PG", "SG", "SF", "PF", "C"] as const).map((p) => <span key={p} className="w-9 text-center" title={`${p} ${pct(m.positions[p] ?? 0)}`}><span className="block h-2 rounded-sm bg-brand" style={{ opacity: 0.25 + (m.positions[p] ?? 0) * 1.5 }} /><span className="text-[9px] text-ink-3">{p}</span></span>)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {auto && (
        <div>
          <div className="mb-1 font-semibold">Autopick detection, draft #{auto.draftId} (pick = best available by ADP; ≥ 60% flags a likely bot or absent manager)</div>
          <div className="flex flex-wrap gap-2">
            {auto.byTeam.map((t) => (
              <div key={t.teamSlot} className={`w-[110px] rounded border p-1 ${t.flagged ? "border-warn" : "border-rule"} ${t.isUser ? "bg-brand-bg" : ""}`}>
                <div className="truncate" title={t.teamName}>{t.teamName}</div>
                <Bar value={t.share} max={1} color={t.flagged ? "bg-warn" : "bg-brand"} />
                <div className="text-ink-3">{t.adpTop}/{t.picks} · {pct(t.share)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 font-semibold">Positional runs (≥ 3 of 5 consecutive picks share a position), % of windows by round</div>
        {a.runs.map((r) => (
          <div key={r.draftId} className="mb-1 flex items-center gap-1">
            <span className="w-14 text-ink-3">draft #{r.draftId}</span>
            {r.byRound.map((x) => <span key={x.round} className="w-9 rounded-sm text-center text-[10px]" style={{ background: `color-mix(in srgb, var(--fc-brand) ${Math.round((0.1 + x.rate * 0.6) * 100)}%, transparent)` }} title={`round ${x.round}: ${x.flagged}/${x.windows}`}>{Math.round(x.rate * 100)}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

function DevList({ title, rows }: { title: string; rows: Dev[] }) {
  return (
    <div>
      <div className="mb-1 font-semibold">{title}</div>
      <table className="text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.draftId}-${r.pick}`} className="border-t border-rule">
              <td className="px-1 text-ink-3">#{r.draftId}</td><td className="px-1 text-ink">{r.name}</td><td className="px-1 text-right">pick {r.pick}</td><td className="px-1 text-right text-ink-2">ADP {r.adp.toFixed(0)}</td>
              <td className={`px-1 text-right ${r.deviation < 0 ? "text-neg" : "text-pos"}`}>{r.deviation > 0 ? "+" : ""}{r.deviation.toFixed(0)}</td><td className="px-1 text-ink-3">{r.teamName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ model

function ModelTab({ a, act, busy }: { a: Analysis; act: (b: { refit?: boolean; enabled?: boolean }) => void; busy: boolean }) {
  const c = a.calibration;
  const m = a.model;
  const surf = m?.detail?.surface ?? [];
  const maxLl = Math.max(...surf.map((s) => s.logLikNoAuto), -Infinity);
  const minLl = Math.min(...surf.map((s) => s.logLikNoAuto), Infinity);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 font-semibold">Survival calibration — P(player still available at my next pick), top 30 available at each of my picks</div>
        <div className="mb-2 text-ink-2">n = {c.n} predictions · Brier <b className="text-ink" data-testid="history-brier">{c.brier.toFixed(4)}</b> (0 perfect, 0.25 coin-flip) · per draft: {c.perDraft.map((d) => `#${d.draftId} ${d.brier.toFixed(3)} (n ${d.n})`).join(" · ")}</div>
        <div className="flex items-end gap-3" data-testid="history-reliability">
          {c.reliability.map((b) => (
            <div key={b.lo} className="flex w-14 flex-col items-center">
              <div className="flex h-40 items-end gap-0.5">
                <div className="w-5 rounded-t-sm bg-ink-3" style={{ height: `${b.meanPredicted * 100}%` }} title={`predicted ${pct(b.meanPredicted, 1)}`} />
                <div className={`w-5 rounded-t-sm ${b.n ? "bg-pos" : "bg-transparent"}`} style={{ height: `${b.observedRate * 100}%` }} title={`observed ${pct(b.observedRate, 1)} (n ${b.n})`} />
              </div>
              <div className="text-[10px] text-ink-2">{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%</div>
              <div className="text-[10px] text-ink-3">n {b.n}</div>
            </div>
          ))}
        </div>
        <div className="mt-1 text-ink-3"><span className="mr-1 inline-block h-2 w-2 bg-ink-3" />predicted (mean of bucket) <span className="ml-3 mr-1 inline-block h-2 w-2 bg-pos" />observed availability rate. Bars of equal height = calibrated.</div>
      </div>

      <div className="max-w-[760px] rounded border border-rule p-3" data-testid="history-fit">
        <div className="mb-1 font-semibold">Fitted opponent model</div>
        {m ? (
          <>
            <div className="text-ink">σ multiplier <b className="text-ink">k = {m.k.toFixed(2)}</b> · autopick mixture <b className="text-ink">{pct(m.autopickShare)}</b> · fitted on {m.detail?.n ?? "?"} opponent picks of drafts {(m.detail?.draftIds ?? []).map((i) => `#${i}`).join(", ")} · {m.fittedAt.slice(0, 16).replace("T", " ")}</div>
            {m.detail?.logLik != null && m.detail.logLikDefault != null && <div className="text-ink-3">log-likelihood {m.detail.logLik.toFixed(1)} vs {m.detail.logLikDefault.toFixed(1)} for the default (k = 1, no autopick). The simulator uses ADP σ = min(22, 0.8 + 0.12·ADP) × k.</div>}
            {surf.length > 0 && (
              <div className="mt-2 flex items-end gap-0.5" title="log-likelihood by k (no autopick)">
                {surf.map((s) => (
                  <div key={s.k} className="flex w-5 flex-col items-center">
                    <div className={`w-4 rounded-t-sm ${s.k === m.k ? "bg-pos" : "bg-track"}`} style={{ height: `${4 + ((s.logLikNoAuto - minLl) / (maxLl - minLl || 1)) * 56}px` }} />
                    <div className="text-[9px] text-ink-3">{s.k.toFixed(1)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="text-ink-3">No fit stored yet.</div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <button disabled={busy} onClick={() => act({ refit: true })} className="rounded-sm bg-raised px-2 py-1 hover:bg-track disabled:opacity-50" data-testid="history-refit">Refit on clean drafts</button>
          <label className="flex items-center gap-1">
            <input type="checkbox" data-testid="history-apply" disabled={busy || !m} checked={!!m?.enabled} onChange={(e) => act({ enabled: e.target.checked })} />
            Apply fitted model (survival simulation + mock bots)
          </label>
          <span className="text-ink-3">{m?.enabled ? "ON: recommendations use the fitted σ." : "OFF: the default model is used."}</span>
        </div>
      </div>
    </div>
  );
}
