"use client";

/* Shared building blocks of the League screens (overview, categories, power, teams, h2h, depth, trades). Data: useReport() / useTrades(). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { CatSummary, DepthRow, H2HRow, InjuryRow, SeasonReport, TeamLine } from "@/engine/season/report";
import type { TradeEval, TradeIdea, TradeSideResult } from "@/engine/season/trades";
import { catVal, CATS, dayLabel, pct } from "./format";
import { IconArrow } from "./icons";
import { Badge, Button, Card, cx, ErrorBar, Gauge, Label, PageTitle, Skeleton, StatusBadge, Delta, type Tone } from "./kit";
import { api, useReport, useSeason } from "./season-data";

export const LEAGUE_PAGES = [
  { href: "/league", label: "Overview" },
  { href: "/league/categories", label: "Categories" },
  { href: "/league/power", label: "Power" },
  { href: "/league/teams", label: "Teams × cats" },
  { href: "/league/h2h", label: "Head-to-head" },
  { href: "/league/depth", label: "Depth & activity" },
  { href: "/league/trades", label: "Trades" },
] as const;

/** Horizontally scrollable chip row to jump between the League sub-pages. */
export function LeagueNav({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <nav aria-label="League pages" className={cx("-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0", className)}>
      {LEAGUE_PAGES.map((p) => {
        const on = path === p.href;
        return (
          <Link key={p.href} href={p.href} aria-current={on ? "page" : undefined} className={cx("shrink-0 rounded-full px-3.5 py-1.5 text-[14px]", on ? "bg-brand-bg font-semibold text-brand" : "bg-raised text-ink-2 hover:text-ink")}>
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}

const WORDS = ["nothing", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
export const headline = (r: SeasonReport) => `Built to win ${WORDS[Math.max(0, Math.min(9, Math.round(r.expCatsWon)))]}.`;

/** Title + nav + loading/error handling around a League sub-page. */
export function LeaguePage({ title, meta, back = true, wide, testid, children }: { title: string | ((r: SeasonReport) => string); meta?: string | ((r: SeasonReport) => React.ReactNode); back?: boolean; wide?: boolean; testid: string; children: (r: SeasonReport) => React.ReactNode }) {
  const { data: r, error, loading } = useReport();
  const { reload } = useSeason();
  return (
    <div data-testid={testid} className={cx("pb-4", !wide && "md:max-w-4xl")}>
      <PageTitle title={r ? (typeof title === "function" ? title(r) : title) : typeof title === "function" ? "League" : title} back={back ? { href: "/league", label: "League" } : undefined} meta={r ? (typeof meta === "function" ? meta(r) : meta) : undefined} />
      <LeagueNav />
      {error && <ErrorBar message={error} onRetry={reload} />}
      {!r && !error && <Skeleton lines={5} label={loading ? "Analysing the league…" : "Loading…"} />}
      {r && children(r)}
    </div>
  );
}

const LABEL: Record<CatSummary["label"], { tone: Tone; text: string }> = { strength: { tone: "pos", text: "Strength" }, weakness: { tone: "neg", text: "Weakness" }, swing: { tone: "warn", text: "Swing" }, neutral: { tone: "neutral", text: "Neutral" } };
const TONE_TEXT: Record<Tone, string> = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink-2", brand: "text-brand" };
export const labelOf = (c: CatSummary) => (c.punt ? { tone: "neutral" as Tone, text: "Punt" } : LABEL[c.label]);

export const Notes = ({ r }: { r: SeasonReport }) =>
  r.notes.length > 0 ? <div className="mt-4 space-y-1 text-[13px] text-ink-3">{r.notes.map((n, i) => <div key={i}>{n}</div>)}</div> : null;

/* ------------------------------------------------------------------ overview */

export function SummaryCard({ r }: { r: SeasonReport }) {
  return (
    <Card className="space-y-3 p-5 text-[16px] leading-snug text-ink" data-testid="league-summary">
      {r.summary.map((s, i) => <p key={i}>{s}</p>)}
    </Card>
  );
}

export function StatTiles({ r }: { r: SeasonReport }) {
  const tiles = [
    { v: pct(r.avgWinProb), l: "Avg P(win)" },
    { v: r.expCatsWon.toFixed(1), l: "Exp. cats / 9" },
    { v: `${r.ilUsed} / ${r.ilSlots}`, l: "IL used" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {tiles.map((t) => (
        <div key={t.l} className="rounded-2xl bg-panel px-3.5 py-3.5">
          <div className="fc-num text-[22px] font-semibold text-ink">{t.v}</div>
          <div className="mt-1 text-[13px] text-ink-2">{t.l}</div>
        </div>
      ))}
    </div>
  );
}

export const userTeam = (r: SeasonReport) => r.teams.find((t) => t.isUser);
export function PowerBadge({ r }: { r: SeasonReport }) {
  const u = userTeam(r);
  return u ? <Badge tone="brand" className="px-3 py-1.5 text-[14px]">Power #{u.powerRank} / {r.teams.length}</Badge> : null;
}

export function LinkList({ r }: { r: SeasonReport }) {
  const items = [
    { href: "/league/categories", t: "Category strengths & rank" },
    { href: "/league/power", t: `Power rankings · All ${r.teams.length} teams` },
    { href: "/league/teams", t: "Teams × 9 category comparison" },
    { href: "/league/h2h", t: "H2H · Hardest opponents first" },
    { href: "/league/depth", t: "Position depth & league activity" },
    { href: "/league/trades", t: "Trade ideas & checker" },
  ];
  return (
    <Card className="px-5 py-2">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="flex items-center justify-between border-b border-rule py-3.5 text-[16px] text-brand last:border-b-0">
          {i.t}<IconArrow />
        </Link>
      ))}
    </Card>
  );
}

/** The nine categories as ranked tiles (desktop header strip, phone strengths/weaknesses). */
export function CatStrip({ cats }: { cats: CatSummary[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 md:grid-cols-9">
      {cats.map((c) => {
        const l = labelOf(c);
        return (
          <div key={c.cat} className="rounded-xl bg-panel px-3 py-2.5">
            <Label>{c.cat}</Label>
            <div className="fc-num mt-1 text-[18px] font-semibold text-ink">#{c.rank}</div>
            <div className={cx("text-[12px]", TONE_TEXT[l.tone])}>{l.text}</div>
            <Gauge p={rankStrength(c)} tone={l.tone} className="mt-1.5 h-[3px]" />
          </div>
        );
      })}
    </div>
  );
}
const rankStrength = (c: CatSummary) => Math.max(0.06, (c.of - c.rank) / Math.max(1, c.of - 1));

/* ------------------------------------------------------------------ categories */

export function CatRows({ cats }: { cats: CatSummary[] }) {
  return (
    <div data-testid="league-cats">
      {cats.map((c) => {
        const l = labelOf(c);
        return (
          <div key={c.cat} className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-b border-rule py-3.5 last:border-b-0 sm:grid-cols-[1fr_90px_140px]">
            <div>
              <div className="fc-num text-[17px] text-ink">{c.cat} <span className="ml-1 font-semibold">{catVal(c.cat, c.value)}</span></div>
              <div className="fc-num mt-1 text-[13px] text-ink-2">Best {catVal(c.cat, c.best)} · Med {catVal(c.cat, c.median)} · {pct(c.avgWinP)}</div>
            </div>
            <div className="fc-num hidden text-center text-[15px] text-ink-2 sm:block">#{c.rank} of {c.of}</div>
            <div className="w-[130px] text-right">
              <div className={cx("text-[14px]", TONE_TEXT[l.tone])}>{l.text}</div>
              <div className="fc-num text-[12px] text-ink-3 sm:hidden">#{c.rank} of {c.of}</div>
              <Gauge p={rankStrength(c)} tone={l.tone} className="mt-1.5 h-1" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CatBenchmarks({ cats }: { cats: CatSummary[] }) {
  return (
    <table className="w-full text-[14px]">
      <thead><tr className="fc-label text-left"><th className="pb-2 font-normal">Cat</th><th className="font-normal">You</th><th className="font-normal">Rank</th><th className="font-normal">Best</th><th className="font-normal">Med</th><th className="text-right font-normal">P(win)</th></tr></thead>
      <tbody className="fc-num">
        {cats.map((c) => (
          <tr key={c.cat} className="border-t border-rule">
            <td className="py-2.5 text-ink">{c.cat}</td><td className="text-ink">{catVal(c.cat, c.value)}</td>
            <td className={TONE_TEXT[labelOf(c).tone]}>#{c.rank}</td><td className="text-ink-2">{catVal(c.cat, c.best)}</td><td className="text-ink-2">{catVal(c.cat, c.median)}</td><td className="text-right text-ink-2">{pct(c.avgWinP)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ power */

const byPower = (teams: TeamLine[]) => [...teams].sort((a, b) => a.powerRank - b.powerRank);

export function PowerList({ teams }: { teams: TeamLine[] }) {
  return (
    <div data-testid="league-power">
      <div className="fc-label mb-1 grid grid-cols-[28px_1fr_64px_56px] gap-2 border-b border-rule pb-2"><span>#</span><span>Team</span><span className="text-right">Power</span><span className="text-right">Games</span></div>
      {byPower(teams).map((t) => (
        <div key={t.slot} className={cx("grid grid-cols-[28px_1fr_64px_56px] items-center gap-2 rounded-lg px-1 py-3", t.isUser && "bg-brand-bg")} aria-current={t.isUser ? "true" : undefined}>
          <span className="fc-num text-[14px] text-ink-3">{t.powerRank}</span>
          <span className={cx("truncate text-[15px]", t.isUser ? "font-semibold text-brand" : "text-ink")}>{t.name}</span>
          <span className="fc-num text-right text-[15px] text-ink">{(t.power * 100).toFixed(1)}%</span>
          <span className="fc-num text-right text-[15px] text-ink-2">{Number.isInteger(t.games) ? t.games : t.games.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ teams × categories */

export function TeamsTable({ teams, compact }: { teams: TeamLine[]; compact?: boolean }) {
  const n = teams.length;
  return (
    <div className="overflow-x-auto" data-testid="league-table">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[14px]">
        <thead>
          <tr className="fc-label text-left">
            <th className="sticky left-0 z-10 bg-panel py-2 pr-3 font-normal">Team</th>
            {CATS.map((c) => <th key={c} className="px-2 text-right font-normal">{c}</th>)}
            {!compact && <th className="px-2 text-right font-normal">Power</th>}
          </tr>
        </thead>
        <tbody>
          {byPower(teams).map((t) => (
            <tr key={t.slot} className={t.isUser ? "bg-brand-bg" : undefined}>
              <td className={cx("sticky left-0 z-10 max-w-[150px] truncate border-t border-rule py-2.5 pr-3", t.isUser ? "bg-brand-bg font-semibold text-brand" : "bg-panel text-ink")}>{t.name}</td>
              {t.cats.map((v, i) => (
                <td key={i} className={cx("fc-num border-t border-rule px-2 text-right", t.ranks[i] <= 3 ? "text-pos" : t.ranks[i] > n - 3 ? "text-neg" : "text-ink")}>{catVal(CATS[i], v)}</td>
              ))}
              {!compact && <td className="fc-num border-t border-rule px-2 text-right text-ink-2">{pct(t.power)} #{t.powerRank}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export const TeamsLegend = () => (
  <div className="flex flex-wrap gap-2"><Badge tone="pos">Top 3</Badge><Badge tone="neg">Bottom 3</Badge><Badge tone="brand">Your team</Badge></div>
);

/* ------------------------------------------------------------------ h2h */

export function H2HList({ rows }: { rows: H2HRow[] }) {
  const sorted = [...rows].sort((a, b) => a.winProb - b.winProb);
  return (
    <div data-testid="league-h2h">
      <div className="fc-label grid grid-cols-[1fr_52px_52px] gap-2 border-b border-rule pb-2"><span>Opponent</span><span className="text-right">Win</span><span className="text-right">Cats</span></div>
      {sorted.map((x) => (
        <div key={x.slot} className="border-b border-rule py-3 last:border-b-0">
          <div className="grid grid-cols-[1fr_52px_52px] items-baseline gap-2">
            <span className="truncate text-[15px] text-ink">{x.name}</span>
            <span className={cx("fc-num text-right text-[15px]", x.winProb < 0.4 ? "text-neg" : x.winProb < 0.6 ? "text-warn" : "text-pos")}>{pct(x.winProb)}</span>
            <span className="fc-num text-right text-[15px] text-ink-2">{x.expCats.toFixed(1)}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-2">
            They lead: {x.theyWin.join(", ") || "none"} · Toss-ups: {x.tossUp.join(", ") || "none"}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ depth + activity */

export function DepthTable({ rows }: { rows: DepthRow[] }) {
  return (
    <table className="w-full text-[14px]" data-testid="league-depth">
      <thead><tr className="fc-label text-left"><th className="pb-2 font-normal">Pos</th><th className="font-normal">Elig / slots</th><th className="font-normal">League med</th><th className="font-normal">Games/wk</th><th /></tr></thead>
      <tbody className="fc-num">
        {rows.map((d) => (
          <tr key={d.pos} className="border-t border-rule">
            <td className="py-3 text-ink">{d.pos}</td>
            <td className="text-ink">{d.eligible} / {d.slots}</td>
            <td className="text-ink-2">{d.leagueMedian}</td>
            <td className="text-ink-2">{Number.isInteger(d.weeklyGames) ? d.weeklyGames : d.weeklyGames.toFixed(1)}</td>
            <td className="text-right font-sans">{d.thin ? <Badge tone="warn">Thin</Badge> : <span className="text-[13px] text-ink-3">OK</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InjuryList({ rows }: { rows: InjuryRow[] }) {
  if (rows.length === 0) return <div className="text-[14px] text-ink-2">No injuries on your roster.</div>;
  return (
    <div>
      {rows.map((i) => (
        <div key={i.playerId} className="flex items-start justify-between gap-3 border-b border-rule py-2.5 last:border-b-0">
          <div className="min-w-0">
            <div className="truncate text-[15px] text-ink">{i.name} <span className="text-[12.5px] text-ink-3">{i.team}</span></div>
            {i.detail && <div className="text-[12.5px] text-ink-2">{i.detail}</div>}
          </div>
          <div className="flex shrink-0 gap-1.5">{i.onIl && <Badge>IL</Badge>}<StatusBadge flag={i.flag} /></div>
        </div>
      ))}
    </div>
  );
}

interface Txn { date: string | null; time: string | null; team: string | null; isUser: boolean; type: "add" | "drop" | "trade"; player: string }
interface TxnGroup { key: string; date: string | null; time: string | null; team: string | null; isUser: boolean; adds: string[]; drops: string[]; trades: string[] }

function groupTxns(list: Txn[]): TxnGroup[] {
  const out: TxnGroup[] = [];
  for (const t of list) {
    const key = `${t.date}|${t.time}|${t.team}`;
    let g = out.find((x) => x.key === key);
    if (!g) {
      g = { key, date: t.date, time: t.time, team: t.team, isUser: t.isUser, adds: [], drops: [], trades: [] };
      out.push(g);
    }
    (t.type === "add" ? g.adds : t.type === "drop" ? g.drops : g.trades).push(t.player);
  }
  return out;
}

/** Recent league transactions (GET /api/season/transactions). */
export function Activity({ limit = 12 }: { limit?: number }) {
  const [state, setState] = useState<{ items: Txn[] | null; error: string | null }>({ items: null, error: null });
  useEffect(() => {
    let alive = true;
    api<{ transactions: Txn[] }>(`/api/season/transactions?limit=${limit * 3}`)
      .then((r) => alive && setState({ items: r.transactions, error: null }))
      .catch((e) => alive && setState({ items: null, error: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [limit]);
  if (state.error) return <ErrorBar message={state.error} />;
  if (!state.items) return <div className="text-[14px] text-ink-2">Loading transactions…</div>;
  const groups = groupTxns(state.items).slice(0, limit);
  if (groups.length === 0) return <div className="text-[14px] text-ink-2" data-testid="league-activity">No transactions recorded yet. They arrive with the Yahoo sync.</div>;
  return (
    <div data-testid="league-activity">
      {groups.map((g) => (
        <div key={g.key} className="border-b border-rule py-3 last:border-b-0">
          <div className="text-[15px] text-ink">
            <span className="fc-num text-ink-2">{g.date ? dayLabel(g.date) : "Unknown date"}{g.time ? ` ${g.time}` : ""}</span> · <span className={g.isUser ? "font-semibold text-brand" : undefined}>{g.team ?? "A team"}</span>
            {g.adds.length > 0 && <> added {g.adds.join(", ")}</>}
            {g.trades.length > 0 && <> {g.adds.length > 0 ? "and traded" : "traded"} {g.trades.join(", ")}</>}
          </div>
          {g.drops.length > 0 && <div className="text-[13px] text-ink-2">Dropped {g.drops.join(", ")}</div>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ trades */

const refNames = (l: { name: string; status?: string }[]) => l.map((p) => p.name).join(" + ") || "nothing";

function Side({ s, you }: { s: TradeSideResult; you?: boolean }) {
  const all = [...s.gets, ...(s.adds ? [s.adds] : [])];
  return (
    <div className="min-w-0 rounded-xl bg-raised p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx("truncate text-[15px] font-semibold", you ? "text-brand" : "text-ink")}>{you ? "You" : s.name}</span>
        <Delta v={s.dRos} className="text-[18px]" />
      </div>
      <div className="fc-num text-[12.5px] text-ink-2">{pct(s.before)} → {pct(s.after)} avg week</div>
      <div className="mt-2 text-[13.5px] text-ink">
        <span className="text-ink-2">Gets </span>{refNames(s.gets)}{s.adds ? <span className="text-ink-2"> + adds FA {s.adds.name}</span> : null}
      </div>
      <div className="text-[13.5px] text-ink"><span className="text-ink-2">Gives </span>{refNames(s.gives)}{s.drops ? <span className="text-ink-2">, drops {s.drops.name}</span> : null}</div>
      {all.filter((p) => p.status).map((p) => <div key={p.playerId} className="mt-1.5"><Badge tone="warn">{p.name}: {p.status}</Badge></div>)}
      {s.reasons.length > 0 && <ul className="mt-2 space-y-0.5 text-[12.5px] text-ink-2">{s.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
    </div>
  );
}

export function TradeCard({ i }: { i: TradeIdea }) {
  return (
    <Card className="p-4" data-testid="trade-idea">
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="brand">{i.kind}</Badge><span className="text-[16px] font-semibold text-ink">with {i.b.name}</span></div>
      <div className="mb-3 text-[14px] text-ink-2">Give {refNames(i.a.gives)}, get {refNames(i.a.gets)}</div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"><Side s={i.a} you /><Side s={i.b} /></div>
    </Card>
  );
}
export function TradeResult({ e }: { e: TradeEval }) {
  return <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="trade-result"><Side s={e.a} /><Side s={e.b} /></div>;
}

const field = "min-h-11 w-full rounded-xl border border-rule bg-canvas px-3.5 text-[15px] text-ink placeholder:text-ink-3";
const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function TradeChecker() {
  const { date } = useSeason();
  const [give, setGive] = useState("");
  const [get, setGet] = useState("");
  const [aTeam, setATeam] = useState("");
  const [bTeam, setBTeam] = useState("");
  const [res, setRes] = useState<TradeEval | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const body = { a: { team: aTeam.trim() || undefined, gives: split(give) }, b: { team: bTeam.trim() || undefined, gives: split(get) }, date: date || undefined };
      setRes(await api<TradeEval>("/api/season/trades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-3 p-4" data-testid="trade-checker">
      <Label>Check a trade</Label>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <input className={field} value={give} onChange={(e) => setGive(e.target.value)} placeholder="You give (comma separated)" aria-label="Side A gives" />
        <input className={field} value={get} onChange={(e) => setGet(e.target.value)} placeholder="You get (comma separated)" aria-label="Side B gives" />
        <input className={field} value={aTeam} onChange={(e) => setATeam(e.target.value)} placeholder="Side A team (empty = you)" aria-label="Side A team" />
        <input className={field} value={bTeam} onChange={(e) => setBTeam(e.target.value)} placeholder="Side B team (empty = from the players)" aria-label="Side B team" />
      </div>
      <Button variant="primary" data-testid="trade-check" disabled={busy || !split(give).length || !split(get).length} onClick={() => void run()} className="w-full sm:w-auto">{busy ? "Checking…" : "Check trade"}</Button>
      {err && <ErrorBar message={err} />}
      {res && <TradeResult e={res} />}
    </Card>
  );
}
