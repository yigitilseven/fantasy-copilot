"use client";

/* Today pieces, shared by the phone screens (/today, /today/lineup, /today/checklist, /today/brief, /today/news) and the
 * desktop three-column Today. The category table and the five-category plan are reused by Matchup. */
import Link from "next/link";
import { useState } from "react";
import type { CatRow, SeasonOverview } from "@/server/season";
import { usePush } from "@/components/push-control";
import { catTone, catVal, catWord, pct } from "./format";
import { IconArrow, IconBell } from "./icons";
import { Badge, Button, Card, cx, Gauge, Label, PlayerRow, StatusBadge } from "./kit";
import type { BriefState } from "./season-data";

// ------------------------------------------------------------------ brief

export interface BriefBlock { title: string; body: string }
const BLOCKS = ["STANDING", "CATEGORIES", "THIS WEEK", "MOVES", "PLAN", "LINEUP", "ROSTER", "TRADES", "RISKS", "WATCH", "NEWS", "TODAY"];

/** Splits Claude's plain-text brief into its blocks ("MOVES: ..."). Engine text without blocks becomes one block. */
export function parseBrief(text: string): BriefBlock[] {
  const re = new RegExp(`^(${BLOCKS.join("|")}):\\s*`, "m");
  if (!re.test(text)) return [{ title: "BRIEF", body: text.trim() }];
  const out: BriefBlock[] = [];
  let cur: BriefBlock | null = null;
  for (const line of text.split("\n")) {
    const m = new RegExp(`^(${BLOCKS.join("|")}):\\s*(.*)$`).exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[1], body: m[2] };
    } else if (cur) cur.body += `\n${line}`;
  }
  if (cur) out.push(cur);
  return out.map((b) => ({ ...b, body: b.body.trim() }));
}
const firstSentence = (s: string) => (/^[^.!?\n]*[.!?]?/.exec(s.replace(/^\d\)\s*/, ""))?.[0] ?? s).trim();
const BLOCK_TONE: Record<string, string> = { MOVES: "text-pos", PLAN: "text-warn", LINEUP: "text-ink-2", RISKS: "text-neg", WATCH: "text-neg", TRADES: "text-brand", STANDING: "text-brand", CATEGORIES: "text-warn", "THIS WEEK": "text-warn", ROSTER: "text-ink-2" };
export const blockTone = (t: string) => BLOCK_TONE[t] ?? "text-ink-2";

export function BriefSourceBadge({ b }: { b: BriefState }) {
  return <Badge tone={b.usedClaude ? "brand" : "neutral"}>{b.usedClaude ? "Claude analysis" : "Engine only"}</Badge>;
}
const briefTime = (b: BriefState) => (b.at ? new Date(b.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null);

/** Collapsed brief: the first sentence of the first three blocks. */
export function BriefCard({ brief }: { brief: BriefState | null }) {
  if (!brief) return null;
  const blocks = parseBrief(brief.text).slice(0, 3);
  return (
    <Card className="p-5" data-testid="brief-card">
      <div className="flex items-center justify-between gap-2">
        <Label>{brief.weekly ? "Weekly plan" : "Daily brief"}{briefTime(brief) ? ` · Today ${briefTime(brief)}` : ""}</Label>
        <BriefSourceBadge b={brief} />
      </div>
      {brief.outdated && <OutdatedNote />}
      <div className={cx("mt-3 space-y-1 text-[15.5px] leading-snug", brief.outdated ? "text-ink-2" : "text-ink")}>
        {blocks.map((b) => (
          <div key={b.title} className="line-clamp-2">
            <span className="mr-1.5 text-ink-2">{b.title}</span>
            {firstSentence(b.body)}
          </div>
        ))}
      </div>
      <Link href="/today/brief" className="mt-3 inline-flex items-center gap-1 text-[15px] text-brand">Read full {brief.weekly ? "weekly plan" : "brief"} <IconArrow /></Link>
    </Card>
  );
}

/** The roster changed after the brief was written (e.g. you already made its move). */
export function OutdatedNote() {
  return (
    <div className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn" data-testid="brief-outdated">
      Written before your latest roster moves, so its suggestions may already be done. A fresh brief is on the way; the Moves tab is always current.
    </div>
  );
}

export function BriefBlocks({ blocks }: { blocks: BriefBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((b) => (
        <Card key={b.title} className="p-5">
          <Label className={blockTone(b.title)}>{b.title}</Label>
          <div className="mt-2 whitespace-pre-line text-[16px] leading-relaxed text-ink">{b.body}</div>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ lineup

const ACTIVE = (slot: string | null) => !!slot && !["BN", "IL", "IL+", "NA"].includes(slot);
export interface LineupRow { slot: string; playerId: string | null; name: string; sub: string; plays: boolean }

/** Active slots as Yahoo has them (slot order of the league), each with what the engine says; engine starters when Yahoo slots are unknown. */
export function lineupRows(d: SeasonOverview): LineupRow[] {
  const starters = new Map(d.lineup.starters.map((s) => [s.playerId, s]));
  const changes = new Map(d.lineup.changes.map((c) => [c.playerId, c]));
  const order = d.league.settings.rosterSlots;
  const yahoo = d.roster.filter((r) => ACTIVE(r.slot));
  const note = (id: string, hasGame: boolean | null) => {
    const s = starters.get(id);
    const c = changes.get(id);
    if (c?.type === "sit") return `Sit · ${c.reason.toLowerCase()}`;
    if (s) return `Start · ${s.reason}`;
    return hasGame === false ? "No game today" : "Bench today";
  };
  if (yahoo.length) {
    const used = new Array(order.length).fill(false);
    const rows: LineupRow[] = [];
    for (const r of yahoo) {
      const i = order.findIndex((s, k) => !used[k] && s === r.slot);
      if (i >= 0) used[i] = true;
      rows.push({ slot: r.slot!, playerId: r.playerId, name: r.name, sub: `${r.team} · ${r.positions} · ${note(r.playerId, r.hasGameToday)}`, plays: !!starters.get(r.playerId) || r.hasGameToday === true });
    }
    rows.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    order.forEach((s, k) => !used[k] && rows.push({ slot: s, playerId: null, name: "", sub: "Nobody eligible has a game", plays: false }));
    return rows.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  }
  const rows: LineupRow[] = d.lineup.starters.map((s) => ({ slot: s.slot, playerId: s.playerId, name: s.name, sub: `${s.team} · ${s.positions} · Start · ${s.reason}`, plays: true }));
  for (const s of d.lineup.emptySlots) rows.push({ slot: s, playerId: null, name: "", sub: "Nobody eligible has a game", plays: false });
  return rows.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
}

export function LineupList({ d }: { d: SeasonOverview }) {
  return (
    <div data-testid="lineup-list">
      {lineupRows(d).map((r, i) =>
        r.playerId ? (
          <PlayerRow key={`${r.slot}-${i}`} slot={r.slot} name={r.name} sub={r.sub} dot={r.plays ? "on" : "off"} />
        ) : (
          <div key={`${r.slot}-${i}`} className="flex items-center gap-3 border-b border-rule py-3 text-[14px] text-ink-2 last:border-b-0">
            <span className="fc-num w-9 text-[11px] text-ink-3">{r.slot}</span>
            {r.sub}
          </div>
        ),
      )}
    </div>
  );
}

export function BenchList({ d }: { d: SeasonOverview }) {
  const ilIds = new Set(d.lineup.il.map((b) => b.playerId));
  // everyone not shown in the lineup (Yahoo's active slots, or the engine's starters when slots are unknown) and not on IL
  const inLineup = new Set(lineupRows(d).map((r) => r.playerId).filter(Boolean));
  const bench = d.roster.filter((r) => !inLineup.has(r.playerId) && !ilIds.has(r.playerId) && r.status !== "il");
  const engineBench = new Map(d.lineup.bench.map((b) => [b.playerId, b]));
  return (
    <div>
      <Label className="mb-1">Bench · {bench.length} players</Label>
      {bench.map((r) => <PlayerRow key={r.playerId} slot="BN" name={r.name} sub={`${r.team} · ${r.positions} · ${engineBench.get(r.playerId)?.reason ?? (r.hasGameToday ? "Has a game" : "No game today")}`} dot={r.hasGameToday ? "on" : "off"} />)}
      <Label className="mb-1 mt-4">Injured list · {d.lineup.il.length}/{d.league.settings.ilSlots}</Label>
      {d.lineup.il.length === 0 && <div className="py-2 text-[14px] text-ink-2">Nobody on IL.</div>}
      {d.lineup.il.map((b) => <PlayerRow key={b.playerId} slot="IL" name={b.name} sub={`${b.team} · ${b.positions} · ${b.reason}`} dot="off" />)}
    </div>
  );
}

// ------------------------------------------------------------------ Yahoo checklist

export interface CheckItem { id: string; title: string; detail: string }
export function checklistItems(d: SeasonOverview): CheckItem[] {
  return [
    ...d.lineup.changes.map((c) => ({ id: `${c.type}:${c.playerId}`, title: `${c.type === "start" ? "START" : "SIT"} ${c.name}${c.toSlot ? ` at ${c.toSlot}` : ""}`, detail: c.reason })),
    ...d.lineup.ilMoves.map((m) => ({ id: `il:${m.playerId}`, title: `Move ${m.name} to IL`, detail: m.ilSlotFree ? "Frees a roster spot" : `${m.reason} (no free IL slot)` })),
  ];
}

/** Per-day checkmarks kept in this browser only (they record what you did in Yahoo; Copilot never changes Yahoo). */
export function YahooChecklist({ d, compact = false }: { d: SeasonOverview; compact?: boolean }) {
  // keyed by day so a new day starts from its own stored state
  return <Checklist key={d.date} d={d} compact={compact} />;
}

const readChecks = (key: string): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
};

function Checklist({ d, compact }: { d: SeasonOverview; compact: boolean }) {
  const items = checklistItems(d);
  const key = `fc:check:${d.date}`;
  const [done, setDone] = useState<Record<string, boolean>>(() => (typeof window === "undefined" ? {} : readChecks(key)));
  const toggle = (id: string) => {
    const next = { ...done, [id]: !done[id] };
    setDone(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode: keep in memory */
    }
  };
  return (
    <Card className="p-4" data-testid="yahoo-checklist">
      <Label>Yahoo checklist</Label>
      {items.length === 0 && <div className="mt-2 text-[14px] text-ink-2">Nothing to change in Yahoo today.</div>}
      <ul className="mt-2 space-y-2.5">
        {items.map((it) => (
          <li key={it.id}>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={!!done[it.id]} onChange={() => toggle(it.id)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--fc-brand)]" />
              <span>
                <span className={cx("block text-[15px] font-semibold", done[it.id] ? "text-ink-2 line-through" : "text-ink")}>{it.title}</span>
                {!compact && <span className="block text-[13px] text-ink-2">{it.detail}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 text-[12.5px] text-ink-2">Checks record your actions; Copilot never changes Yahoo.</div>
    </Card>
  );
}

// ------------------------------------------------------------------ matchup categories

const TONE_TXT = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink" } as const;
const TONE_WORD = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink-2" } as const;

/** Category rows: current → projected for you and the opponent, P(win) gauge, won/swing/lost word. */
export function CatTable({ cats, opponent }: { cats: CatRow[]; opponent: string | null }) {
  return (
    <div data-testid="cat-table">
      <Label className="mb-1">Current → projected · You / {opponent ?? "Opponent"}</Label>
      {cats.map((c) => {
        const t = catTone(c.p);
        return (
          <div key={c.cat} className="border-b border-rule py-3 last:border-b-0">
            <div className="grid grid-cols-[52px_1fr_1fr_56px] items-baseline gap-2">
              <span className="text-[14px] font-semibold text-ink">{c.cat}</span>
              <span className="fc-num text-right text-[13px] text-ink">{c.youCur != null ? `${catVal(c.cat, c.youCur)} → ` : ""}{catVal(c.cat, c.youProj)}</span>
              <span className="fc-num text-right text-[13px] text-ink-2">{c.oppCur != null ? `${catVal(c.cat, c.oppCur)} → ` : ""}{catVal(c.cat, c.oppProj)}</span>
              <span className={cx("fc-num text-right text-[14px]", TONE_TXT[t])}>{pct(c.p)}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-[1fr_56px] items-center gap-2">
              <Gauge p={c.p} tone={t} className="h-[3px]" />
              <span className={cx("text-right text-[11px]", TONE_WORD[t])}>{catWord(c.p)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Chase the swing categories, protect the won ones, concede the lost ones (5 of 9 wins the week). */
export function fivePlan(cats: Pick<CatRow, "cat" | "p">[]) {
  return {
    chase: cats.filter((c) => c.p >= 0.35 && c.p <= 0.65).map((c) => c.cat),
    protect: cats.filter((c) => c.p > 0.8).map((c) => c.cat),
    concede: cats.filter((c) => c.p < 0.3).map((c) => c.cat),
  };
}
export function FivePlan({ cats }: { cats: Pick<CatRow, "cat" | "p">[] }) {
  const f = fivePlan(cats);
  return (
    <Card className="p-4" data-testid="five-plan">
      <Label>The five-category plan</Label>
      <div className="mt-2 space-y-1.5 text-[15px]">
        <div className="text-warn">Chase: {f.chase.join(", ") || "–"}</div>
        <div className="text-pos">Protect: {f.protect.join(", ") || "–"}</div>
        <div className="text-ink-2">Concede: {f.concede.join(", ") || "–"}</div>
      </div>
      <div className="mt-3 text-[11.5px] text-ink-2">Won ≥85% · Swing 35–65% · Lost ≤15%. TO is lower-is-better.</div>
    </Card>
  );
}

// ------------------------------------------------------------------ alerts and news

export function AlertList({ d }: { d: SeasonOverview }) {
  if (!d.alerts.length) return null;
  return (
    <div className="space-y-2">
      {d.alerts.map((a, i) => (
        <Card key={i} className="p-4">
          <Label className={a.kind === "fa-bump" ? "text-pos" : a.kind === "il-move" ? "text-warn" : "text-ink-2"}>{a.kind === "fa-bump" ? "Minutes up" : a.kind === "il-move" ? "IL move" : a.kind === "gtd" ? "Game-time decision" : "Activate"}</Label>
          <div className="mt-1 text-[15px] text-ink">{a.title}</div>
          <div className="mt-0.5 text-[13px] text-ink-2">{a.detail}</div>
        </Card>
      ))}
    </div>
  );
}

export function NewsList({ d, limit }: { d: SeasonOverview; limit?: number }) {
  const rows = d.news.filter((n) => n.headlines.length).slice(0, limit);
  if (!rows.length) return <div className="text-[14px] text-ink-2">No news for your players.</div>;
  return (
    <div className="space-y-2">
      {rows.map((n) => (
        <Card key={n.playerId} className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{n.name}</span>
            <span className="text-[13px] text-ink-2">{n.team}</span>
            {n.status !== "healthy" && <StatusBadge flag={n.status} detail={[n.injury ? `(${n.injury})` : null, n.estReturn ? `· back ${n.estReturn}` : null].filter(Boolean).join(" ")} />}
          </div>
          {n.headlines.slice(0, 3).map((h, i) => (
            <div key={i} className="mt-1.5 text-[13px] text-ink-2">
              {h.link ? <a href={h.link} target="_blank" rel="noreferrer" className="text-ink hover:underline">{h.title}</a> : <span className="text-ink">{h.title}</span>}
              {" "}· {h.source}{h.publishedAt ? ` · ${h.publishedAt.slice(0, 10)}` : ""}
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ notifications onboarding

/** Shown on Today until notifications are on: the iOS install steps when needed, otherwise one tap to enable. */
export function NotificationCard() {
  const { ui, msg, busy, enable } = usePush();
  // only when there is something to do here (blocked / unsupported / insecure are explained in Settings)
  if (!ui || (ui.state !== "can-enable" && ui.state !== "install-needed")) return null;
  return (
    <Card className="p-5" data-testid="notification-card">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-brand"><IconBell /></span>
        <div className="flex-1">
          <div className="text-[16px] font-semibold text-ink">Get your morning brief and move alerts</div>
          <div className="mt-1 text-[13.5px] text-ink-2">{ui.message}</div>
          {ui.steps && <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[13.5px] text-ink-2">{ui.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
          {ui.state === "can-enable" && <Button variant="primary" className="mt-3" disabled={busy} onClick={() => void enable()} data-testid="push-enable">Enable notifications</Button>}
          {msg && <div className="mt-2 text-[13px] text-ink-2">{msg}</div>}
        </div>
      </div>
    </Card>
  );
}
