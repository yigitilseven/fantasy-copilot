"use client";

/* Matchup pieces: the score in categories, the category table, the adds-used editor, and the pure helpers behind the
 * defense / adds plan. Colors only through tokens; class names come from lookup objects. */
import { useState } from "react";
import type { MoveSuggestion } from "@/engine/season/addDrop";
import type { CatRow, WeekBlock } from "@/server/season";
import { catTone, catVal, catWord, pct, type CatTone } from "./format";
import { Button, Card, cx, Gauge, Label } from "./kit";

const TEXT: Record<CatTone, string> = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink" };
const WORD: Record<CatTone, string> = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink-2" };

// ------------------------------------------------------------------ pure helpers

export type Side = "you" | "opp" | "tie";
/** Who leads a category right now (TO: lower is better); null without live totals. */
export function catLeader(c: Pick<CatRow, "cat" | "youCur" | "oppCur">): Side | null {
  if (c.youCur == null || c.oppCur == null) return null;
  const d = c.cat === "TO" ? c.oppCur - c.youCur : c.youCur - c.oppCur;
  return Math.abs(d) < 1e-9 ? "tie" : d > 0 ? "you" : "opp";
}
/** Categories each side currently leads; null when live totals were not captured. */
export function currentScore(cats: CatRow[], captured: boolean): { you: number; opp: number; tie: number } | null {
  if (!captured) return null;
  const s = { you: 0, opp: 0, tie: 0 };
  let known = 0;
  for (const c of cats) {
    const l = catLeader(c);
    if (l) { s[l]++; known++; }
  }
  return known ? s : null;
}
/** Categories to defend: you lead (or are favored without live totals) but the win is not locked (<85%). Weakest first. */
export function defendCats(cats: CatRow[], captured: boolean): CatRow[] {
  return cats
    .filter((c) => (captured && catLeader(c) ? catLeader(c) === "you" : c.p > 0.5) && c.p < 0.85)
    .sort((a, b) => a.p - b.p);
}
/** Categories a move helps this week, read from its "this week: REB +10.1 pp, 3PM +6.6 pp" reason. */
export function helpedCats(m: Pick<MoveSuggestion, "reasons">): string[] {
  const r = m.reasons.find((x) => x.toLowerCase().startsWith("this week:"));
  if (!r) return [];
  return r.slice(r.indexOf(":") + 1).split(",").map((t) => t.trim()).filter((t) => /\s\+\d/.test(t)).map((t) => t.split(/\s+/)[0]);
}
export interface PlanMove { m: MoveSuggestion; helps: string[] }
/** Suggested moves that help any of the given categories, most chase categories first, then biggest weekly gain. */
export function movesForCats(moves: MoveSuggestion[], cats: string[]): PlanMove[] {
  return moves
    .map((m) => ({ m, helps: helpedCats(m).filter((c) => cats.includes(c)) }))
    .filter((x) => x.helps.length > 0)
    .sort((a, b) => b.helps.length - a.helps.length || b.m.dWeek - a.m.dWeek);
}
/** The highest-leverage category that is still undecided (swing), the "lever" of the week. */
export function leverCat(cats: CatRow[]): CatRow | null {
  const open = cats.filter((c) => c.p > 0.15 && c.p < 0.85);
  return open.length ? open.reduce((a, b) => (b.leverage > a.leverage ? b : a)) : null;
}

// ------------------------------------------------------------------ components

/** "4 – 3 in categories" style score line. */
export function ScoreCard({ week }: { week: WeekBlock }) {
  const s = currentScore(week.cats, week.matchupCaptured);
  return (
    <Card className="p-4" data-testid="score-card">
      <Label>Score in categories right now</Label>
      {s ? (
        <div className="mt-2 flex items-baseline gap-3">
          <span className="fc-num text-[34px] font-light leading-none text-ink">{s.you}<span className="mx-2 text-ink-3">–</span>{s.opp}</span>
          <span className="text-[14px] text-ink-2">You lead {s.you}, {week.opponent ?? "opponent"} leads {s.opp}{s.tie ? `, ${s.tie} tied` : ""}</span>
        </div>
      ) : (
        <div className="mt-2 text-[14px] leading-snug text-ink-2" data-testid="not-captured">
          Live totals were not read from Yahoo yet, so this is projections only. The next Yahoo sync (hourly, or Refresh data in Settings) brings in the current score.
        </div>
      )}
    </Card>
  );
}

/** Category rows: current → projected for you and the opponent, P(win), gauge, won/swing/lost word. */
export function CatTable2({ cats, opponent, captured, legend = true }: { cats: CatRow[]; opponent: string | null; captured: boolean; legend?: boolean }) {
  return (
    <Card className="p-4" data-testid="cat-table">
      <Label className="mb-1">{captured ? "Current → projected" : "Projected"} · You / {opponent ?? "Opponent"}</Label>
      {cats.map((c) => {
        const t = catTone(c.p);
        const lead = captured ? catLeader(c) : null;
        return (
          <div key={c.cat} className="border-b border-rule py-3 last:border-b-0">
            <div className="grid grid-cols-[52px_1fr_1fr_48px] items-baseline gap-2">
              <span className="text-[14px] font-semibold text-ink">{c.cat}</span>
              <span className={cx("fc-num text-right text-[13px]", lead === "you" ? "font-semibold text-ink" : "text-ink")}>{c.youCur != null ? `${catVal(c.cat, c.youCur)} → ` : ""}{catVal(c.cat, c.youProj)}</span>
              <span className={cx("fc-num text-right text-[13px]", lead === "opp" ? "font-semibold text-ink" : "text-ink-2")}>{c.oppCur != null ? `${catVal(c.cat, c.oppCur)} → ` : ""}{catVal(c.cat, c.oppProj)}</span>
              <span className={cx("fc-num text-right text-[14px]", TEXT[t])}>{pct(c.p)}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-[1fr_64px] items-center gap-2">
              <Gauge p={c.p} tone={t} className="h-[3px]" />
              <span className={cx("text-right text-[11px]", WORD[t])}>{catWord(c.p)}</span>
            </div>
          </div>
        );
      })}
      {legend && <div className="mt-2 text-[12px] leading-snug text-ink-2">TO: lower is better. Won ≥85% · Swing 35–65% · Lost ≤15%; other values are leaning, not locks.</div>}
    </Card>
  );
}

/** Adds used this week: 0..limit; "reset" goes back to the adds recorded from your moves (null). */
export function AddsEditor({ week, onSet }: { week: WeekBlock; onSet: (n: number | null) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = async (n: number | null) => {
    setBusy(true);
    setErr(null);
    try { await onSet(n); } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  const opts = Array.from({ length: week.addsLimit + 1 }, (_, i) => i);
  return (
    <Card className="p-4" data-testid="adds-editor">
      <div className="flex items-center justify-between gap-2">
        <Label>Adds used · edit scenario</Label>
        <span className="rounded-lg bg-raised px-2.5 py-1 text-[13px] text-ink-2"><span className="fc-num">{week.addsUsed}</span> of <span className="fc-num">{week.addsLimit}</span></span>
      </div>
      <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${opts.length}, minmax(0, 1fr))` }} role="group" aria-label="Adds used this week">
        {opts.map((n) => (
          <button key={n} type="button" disabled={busy} aria-pressed={week.addsUsed === n} onClick={() => void set(n)}
            className={cx("fc-num min-h-11 rounded-xl text-[17px] transition disabled:opacity-50", week.addsUsed === n ? "bg-brand text-brand-ink" : "bg-raised text-ink hover:brightness-110")}>{n}</button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13.5px] text-ink-2">
        <span>{week.addsRemaining} left. Changing this does not change Yahoo’s add count.</span>
        <Button variant="ghost" className="min-h-9 px-2 text-[14px]" disabled={busy} onClick={() => void set(null)}>Reset to recorded</Button>
      </div>
      {err && <div className="mt-2 text-[13px] text-neg">{err}</div>}
    </Card>
  );
}
