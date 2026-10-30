"use client";

import { CATEGORIES, type Projection, type ProjectionLine } from "@/types";
import { useDraftStore } from "@/store/draft-store";
import type { DraftDerived } from "@/store/derived";
import { ZBar } from "@/components/categories/category-profile";
import { StateBadge } from "@/components/player-table/state-badge";
import { StatusPill } from "@/components/player-table/status-pill";
import { displayCat, injuryText } from "@/engine/recommendation/explain";
import { OPT_VIEWS, VIEW_LABELS } from "@/engine/standings-opt/lines";
import { ROTO_CATEGORIES } from "@/engine/evaluation/standings";
import type { Row } from "@/components/player-table/rows";

const reasonText = (r: string) => (r === "low-gp" ? "Fewer than 25 games in 2025-26: Yahoo projection only" : r === "no-actual" ? "No 2025-26 NBA.com stats (rookie?): Yahoo projection only" : "No Yahoo projection: 2025-26 actual only");
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function sourceLine(label: string, l: ProjectionLine | null): string {
  if (!l) return `${label}: n/a`;
  const f = (x: number) => x.toFixed(1);
  return `${label}: ${Math.round(l.games)} G${l.minutes > 0 ? ` · ${f(l.minutes)} MPG` : ""} · ${f(l.pts)} PTS · ${f(l.threePm)} 3PM · ${f(l.reb)} REB · ${f(l.ast)} AST · ${f(l.stl)} STL · ${f(l.blk)} BLK · ${f(l.tov)} TO · FG ${l.fga > 0 ? (l.fgm / l.fga).toFixed(3) : "–"} · FT ${l.fta > 0 ? (l.ftm / l.fta).toFixed(3) : "–"}`;
}

/** The per-game line the valuation is built from, labelled with where it came from. */
function ProjectionLine({ projection: p }: { projection: Projection }) {
  const yahoo = p.projectionSource === "yahoo-2026-27" || p.projectionSource === "consensus-2026-27";
  const blend = p.projectionSource === "blend" ? p.blend : undefined;
  const auto = blend?.mode === "auto" && blend.wRate !== undefined && blend.wVol !== undefined;
  const fpLine = p.components?.fantasyPros ?? null;
  const tip = blend
    ? [
        auto ? `Auto blend: ${Math.round(blend.wRate! * 100)}% projection / ${Math.round((1 - blend.wRate!) * 100)}% real for per-36 rates, ${Math.round(blend.wVol! * 100)}% / ${Math.round((1 - blend.wVol!) * 100)}% for games and minutes (${(blend.reasons ?? []).join("; ")})` : "",
        sourceLine(fpLine ? "Projection (Yahoo + FantasyPros avg)" : "Yahoo 2026-27", blend.yahoo),
        fpLine ? sourceLine("FantasyPros", fpLine) : "",
        auto && blend.yahooMinutes ? `Projected minutes used: ${blend.yahooMinutes.toFixed(1)} MPG (Yahoo has none: scaled from ${fpLine ? "FantasyPros" : "2025-26"} minutes by production^0.85)` : "",
        sourceLine("Actual 2025-26", blend.actual),
        sourceLine("Actual 2024-25", p.components?.actualPrev ?? null),
      ].filter(Boolean).join("\n")
    : p.blend?.reason ? reasonText(p.blend.reason) : undefined;
  const pct = (m: number, a: number) => (a > 0 ? (m / a).toFixed(3).replace(/^0/, "") : "–");
  const f = (x: number) => x.toFixed(1);
  return (
    <div data-testid="projection-line" data-source={p.projectionSource} title={tip} className="truncate text-[10px] fc-num text-ink-2">
      <span className={`mr-1.5 rounded-sm px-1 font-semibold ${blend ? "bg-brand-bg text-brand" : yahoo ? "bg-brand-bg text-brand" : "bg-raised text-ink-2"}`}>
        {blend
          ? auto
            ? `Blend ${Math.round(blend.wRate! * 100)}% Yahoo — ${blend.reasons?.[0] ?? "default"}`
            : `Blend ${Math.round(blend.effectiveWeight * 100)}% Yahoo / ${Math.round((1 - blend.effectiveWeight) * 100)}% 2025-26`
          : yahoo
            ? p.blend?.reason ? `${p.projectionSource === "consensus-2026-27" ? "Yahoo+FP" : "Yahoo"} 2026-27 proj (${p.blend.reason === "low-gp" ? "few 2025-26 games" : "no 2025-26 stats"})` : p.projectionSource === "consensus-2026-27" ? "Yahoo+FP 2026-27 proj" : "Yahoo 2026-27 proj"
            : p.blend ? "2025-26 actual" : "NBA stats (last season)"}
      </span>
      {auto && <span data-testid="projection-weights" className="mr-1.5 text-brand">rates {Math.round(blend!.wRate! * 100)}% · volume {Math.round(blend!.wVol! * 100)}%{blend!.reasons && blend!.reasons.length > 1 ? ` (${blend!.reasons.slice(1).map(sentence).join("; ")})` : ""}</span>}
      {Math.round(p.games)} G · {f(p.pts)} PTS · {f(p.threePm)} 3PM · {f(p.reb)} REB · {f(p.ast)} AST · {f(p.stl)} STL · {f(p.blk)} BLK · {f(p.tov)} TO · FG {pct(p.fgm, p.fga)} · FT {pct(p.ftm, p.fta)}
    </div>
  );
}

/** Standings breakdown of the selected candidate: weekly win odds and roto rank per view with / without him, and the categories he moves. */
function StandingsDetail({ playerId }: { playerId: string }) {
  const st = useDraftStore((s) => s.standings);
  const a = st?.analysis;
  const c = a?.candidates[playerId];
  if (!a || !c || st?.currentPick === undefined) return null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const sgn = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  const moves = ROTO_CATEGORIES.map((k) => ({ k, d: c.views.proj.dCats[k] + c.views.total.dCats[k] + c.views.avg.dCats[k] })).filter((m) => Math.abs(m.d) >= 0.6).sort((p, q) => q.d - p.d);
  return (
    <div data-testid="standings-detail" className="mt-1 border-t border-rule pt-1 text-[10px] leading-snug fc-num text-ink-2">
      <div>
        <span className="text-ink-3">Weekly win odds </span>
        <span className="text-ink">{pct(a.baseline.h2h.winProb)}</span> {"\u2192"}{" "}
        <span className={c.dWinProb >= 0 ? "font-semibold text-pos" : "font-semibold text-neg"}>{pct(c.winProb)}</span>
        <span className="text-ink-3"> ({sgn(c.dWinProb * 100)} pts)</span>
        {c.moves.length > 0 && <span className="ml-1.5 text-pos">{c.moves.slice(0, 4).map((m) => `+${displayCat(m)}`).join(" ")}</span>}
      </div>
      <div data-testid="standings-ranks">
        <span className="text-ink-3">Roto rank (without {"\u2192"} with): </span>
        {OPT_VIEWS.map((v) => (
          <span key={v} className="mr-2">
            {VIEW_LABELS[v]} #{a.baseline.views[v].rankMedian}{"\u2192"}<span className={c.views[v].rankMedian < a.baseline.views[v].rankMedian ? "font-semibold text-pos" : "text-ink"}>#{c.views[v].rankMedian}</span>
          </span>
        ))}
        <span className="text-ink-3">{moves.map((m) => `${sgn(m.d)} ${displayCat(m.k)}`).join(" ")}</span>
      </div>
    </div>
  );
}

export function RecommendationBar({ rows, derived }: { rows: Row[]; derived: DraftDerived }) {
  const scores = useDraftStore((s) => s.scores);
  const recordById = useDraftStore((s) => s.recordById);
  const selectedIndex = useDraftStore((s) => s.selectedIndex);
  const simStatus = useDraftStore((s) => s.simStatus);

  const top = scores.find((s) => s.recommendation === "DRAFT") ?? scores.find((s) => s.recommendation === "TAKE");
  const topRec = top ? recordById[top.playerId] : null;
  const target = derived.survivalTarget;

  let headline = "No recommendation";
  if (top && topRec) {
    const name = topRec.player.name.toUpperCase();
    const gone = top.survival == null ? null : Math.round((1 - top.survival) * 100);
    headline = `${top.recommendation} ${name}`;
    if (gone != null && target != null) headline += ` — ${gone}% chance he disappears before #${target}`;
    else if (simStatus === "running") headline += " — simulating survival…";
  }

  const sel = rows[Math.min(selectedIndex, rows.length - 1)];
  const selVal = sel?.valuation;

  return (
    <div data-testid="recommendation-bar" className="flex h-[158px] shrink-0 border-t border-rule bg-panel">
      <div data-testid="recommendation" className="flex w-1/2 flex-col gap-1 border-r border-brand/40 bg-brand-bg px-4 py-2">
        <div className="fc-label text-brand">Recommendation</div>
        <div className={`text-base font-semibold ${top?.recommendation === "DRAFT" ? "text-brand" : "text-ink"}`}>{headline}</div>
        <div className="text-[11px] leading-snug text-ink-2">{top?.reason}</div>
      </div>
      <div data-testid="selected-detail" className="flex min-w-0 flex-1 gap-4 px-3 py-2">
        {sel && selVal ? (
          <>
            <div className="w-56 shrink-0 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-bold text-ink">{sel.record.player.name}</span>
                <StateBadge state={sel.score.recommendation} />
                <StatusPill risk={sel.record.risk} />
              </div>
              {injuryText(sel.record.risk) && (
                <div data-testid="injury-line" className="mt-0.5 truncate text-[10px] text-warn" title={injuryText(sel.record.risk)!}>{injuryText(sel.record.risk)}</div>
              )}
              <dl className="fc-num mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-px">
                <dt className="text-ink-3">9-Cat value</dt><dd>{sel.score.nineCat.toFixed(0)} <span className="text-ink-3">(Σz {selVal.nineCat.toFixed(1)})</span></dd>
                <dt className="text-ink-3">Roster fit</dt><dd>{sel.score.rosterFit.toFixed(0)}</dd>
                {sel.score.roto !== undefined && (<><dt className="text-ink-3">Roto score</dt><dd data-testid="roto-score">{sel.score.roto.toFixed(0)}</dd></>)}
                <dt className="text-ink-3">Injury risk</dt><dd>{sel.score.riskLabel} ({sel.score.riskScore.toFixed(0)})</dd>
                <dt className="text-ink-3">Risk-adjusted</dt><dd>{sel.score.riskAdjusted.toFixed(1)}</dd>
                <dt className="text-ink-3">Survival{target ? ` to #${target}` : ""}</dt>
                <dd>{sel.score.survival == null ? "–" : sel.score.survival < 0.01 ? "<1%" : `${Math.round(sel.score.survival * 100)}%`}</dd>
              </dl>
              {sel.record.risk.latestNews?.[0] && (
                <a
                  data-testid="latest-news"
                  href={sel.record.risk.latestNews[0].link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${sel.record.risk.latestNews[0].title} (${sel.record.risk.latestNews[0].source})`}
                  className="mt-1 block truncate text-[10px] text-brand hover:underline"
                >
                  📰 {sel.record.risk.latestNews[0].title}
                </a>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 self-start">
              <div className="grid grid-cols-3 gap-x-4 gap-y-0.5">
                {CATEGORIES.map((c) => (
                  <div key={c} className="flex items-center gap-1.5 text-[11px]">
                    <span className="w-8 text-ink-2">{c}</span>
                    <ZBar value={selVal.z[c]} max={3} />
                    <span className="w-8 text-right fc-num text-ink">{selVal.z[c].toFixed(1)}</span>
                  </div>
                ))}
              </div>
              <ProjectionLine projection={sel.record.projection} />
              <StandingsDetail playerId={sel.score.playerId} />
            </div>
          </>
        ) : (
          <span className="text-[11px] text-ink-3">No player selected.</span>
        )}
      </div>
    </div>
  );
}
