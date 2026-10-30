"use client";

/* Component kit from the Figma design system page: cards, labels, badges, deltas, the probability hero and gauge, category chips,
 * player rows, freshness chips, the move card and page states. Colors only through the --fc-* tokens (dark/light). */
import Link from "next/link";
import type { MoveSuggestion } from "@/engine/season/addDrop";
import type { CatRow } from "@/server/season";
import { catTone, catWord, initials, pct, pp, type CatTone } from "./format";
import { IconArrow, IconBack, IconExternal } from "./icons";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const TONE_TEXT: Record<CatTone | "brand", string> = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink-2", brand: "text-brand" };
const TONE_BAR: Record<CatTone | "brand", string> = { pos: "bg-pos", warn: "bg-warn", neg: "bg-neg", neutral: "bg-ink-2", brand: "bg-brand" };
const TONE_BADGE: Record<CatTone | "brand", string> = { pos: "bg-pos-bg text-pos", warn: "bg-warn-bg text-warn", neg: "bg-neg-bg text-neg", neutral: "bg-raised text-ink-2", brand: "bg-brand-bg text-brand" };
export type Tone = CatTone | "brand";

export function Card({ children, className, as: As = "section", ...rest }: { children: React.ReactNode; className?: string; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return <As className={cx("rounded-2xl border border-rule bg-panel p-4", className)} {...rest}>{children}</As>;
}

export const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={cx("fc-label", className)}>{children}</div>;

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-[12px] font-medium", TONE_BADGE[tone], className)}>{children}</span>;
}

/** "+5.2pp" colored by sign. */
export function Delta({ v, className, unit }: { v: number; className?: string; unit?: string }) {
  const tone = v > 0.0005 ? "text-pos" : v < -0.0005 ? "text-neg" : "text-ink-2";
  return <span className={cx("fc-num font-semibold", tone, className)}>{pp(v, unit)}</span>;
}
export function DeltaPill({ v }: { v: number }) {
  return <span className={cx("fc-num rounded-md px-1.5 py-0.5 text-[12px]", v >= 0 ? "bg-pos-bg text-pos" : "bg-neg-bg text-neg")}>{pp(v)}</span>;
}

/** Horizontal gauge (probabilities are never drawn as a score). */
export function Gauge({ p, tone = "brand", className }: { p: number; tone?: Tone; className?: string }) {
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-track", className)} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <div className={cx("h-full rounded-full", TONE_BAR[tone])} style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
    </div>
  );
}

/** "47% to win this week vs X" with the gauge. */
export function ProbHero({ p, title = "to win this week", opponent, tag = "H2H · 9 categories", size = "lg" }: { p: number; title?: string; opponent?: string | null; tag?: string; size?: "lg" | "md" }) {
  const big = size === "lg" ? "text-[88px]" : "text-[64px]";
  return (
    <div>
      <div className="flex items-start gap-4">
        <div className={cx("font-light leading-none tracking-tight text-ink", big)} data-testid="win-prob">
          {Math.round(p * 100)}
          <span className="align-baseline text-[0.42em] font-normal">%</span>
        </div>
        <div className="pt-1">
          <div className="text-[17px] text-ink">{title}</div>
          {opponent && <div className="text-[15px] text-ink-2">vs {opponent}</div>}
          {tag && <Badge className="mt-1.5">{tag}</Badge>}
        </div>
      </div>
      <Gauge p={p} className="mt-4 max-w-[330px]" />
    </div>
  );
}

/** One category: "REB 44%" with its own mini gauge, toned won/swing/lost. */
export function CatChip({ cat, p }: { cat: string; p: number }) {
  const t = catTone(p);
  return (
    <div className="rounded-lg bg-panel px-3 py-2.5" title={`${cat}: ${pct(p)} to win (${catWord(p)})`}>
      <div className={cx("fc-num text-[14px]", TONE_TEXT[t])}>
        {cat} <span className="ml-1">{pct(p)}</span>
      </div>
      <Gauge p={p} tone={t} className="mt-2 h-[3px] max-w-[90%]" />
    </div>
  );
}
export function CatGrid({ cats }: { cats: Pick<CatRow, "cat" | "p">[] }) {
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="cat-grid">
      {cats.map((c) => <CatChip key={c.cat} cat={c.cat} p={c.p} />)}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  return <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-[12px] font-semibold text-ink">{initials(name)}</span>;
}

/** Roster row: slot · initials · name / "TEAM · POS · reason" · game dot. */
export function PlayerRow({ slot, name, sub, dot, right, className }: { slot?: string | null; name: string; sub?: React.ReactNode; dot?: "on" | "off" | null; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 border-b border-rule py-2.5 last:border-b-0", className)}>
      {slot !== undefined && <span className="fc-num w-9 shrink-0 text-[11px] text-ink-3">{slot ?? ""}</span>}
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-ink">{name}</div>
        {sub && <div className="truncate text-[12.5px] text-ink-2">{sub}</div>}
      </div>
      {right}
      {dot && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", dot === "on" ? "bg-pos" : "bg-ink-3")} aria-label={dot === "on" ? "plays today" : "no game today"} />}
    </div>
  );
}

/** Healthy / GTD / Out / IL, or a detailed "Out (Shoulder) · back 2027-03-02". */
export function StatusBadge({ flag, detail }: { flag: string; detail?: string }) {
  const f = flag.toLowerCase();
  const tone: Tone = f === "healthy" ? "pos" : f === "gtd" || f === "dtd" ? "warn" : f === "il" ? "neutral" : "neg";
  const label = f === "healthy" ? "Healthy" : f === "gtd" || f === "dtd" ? "GTD" : f === "ofs" ? "Out for season" : f === "il" ? "IL" : "Out";
  return <Badge tone={tone}>{detail ? `${label} ${detail}` : label}</Badge>;
}

/** Freshness chip: ok stays gray; only stale / failed use alert colors. */
export function FreshChip({ label, state, detail }: { label: string; state: "ok" | "stale" | "failed" | "idle"; detail?: string }) {
  const tone: Tone = state === "stale" ? "warn" : state === "failed" ? "neg" : "neutral";
  return <Badge tone={tone}>{label}{detail ? ` · ${detail}` : state === "ok" ? " · ok" : state === "idle" ? "" : ` · ${state}`}</Badge>;
}

export function Button({ children, variant = "secondary", className, ...rest }: { children: React.ReactNode; variant?: "primary" | "secondary" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = variant === "primary" ? "bg-brand text-brand-ink hover:brightness-110" : variant === "ghost" ? "text-brand hover:underline" : "bg-raised text-ink hover:brightness-110";
  return <button className={cx("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-[15px] font-medium transition disabled:opacity-50", v, className)} {...rest}>{children}</button>;
}
export function LinkButton({ href, children, variant = "secondary", className }: { href: string; children: React.ReactNode; variant?: "primary" | "secondary"; className?: string }) {
  const v = variant === "primary" ? "bg-brand text-brand-ink hover:brightness-110" : "bg-raised text-ink hover:brightness-110";
  return <Link href={href} className={cx("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-center text-[15px] font-medium transition", v, className)}>{children}</Link>;
}
/** "Lineup & Yahoo checklist →" */
export function MoreLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return <Link href={href} className={cx("inline-flex items-center gap-1 text-[15px] font-medium text-ink-2 hover:text-ink", className)}>{children}<IconArrow /></Link>;
}

/** Big page title with an optional back link / breadcrumb line ("← Today · Daily brief · Oct 27"). */
export function PageTitle({ title, back, meta, right }: { title: string; back?: { href: string; label: string }; meta?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-5 mt-2">
      <div className="flex items-end justify-between gap-3">
        <h1 className="text-[34px] font-normal leading-tight tracking-tight text-ink">{title}</h1>
        {right}
      </div>
      {(back || meta) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[14px] text-ink-2">
          {back && <Link href={back.href} className="inline-flex items-center gap-1 hover:text-ink"><IconBack />{back.label}</Link>}
          {back && meta && <span>·</span>}
          {meta}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-xl bg-raised p-1" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)} className={cx("min-h-9 flex-1 rounded-lg text-[14px]", o.value === value ? "bg-canvas text-ink" : "text-ink-2")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ lines = 3, label = "Computing lineup and moves…" }: { lines?: number; label?: string }) {
  return (
    <div className="rounded-2xl border border-rule bg-panel p-4" aria-busy>
      <div className="mb-3 h-3 w-1/3 animate-pulse rounded bg-raised" />
      {Array.from({ length: lines }, (_, i) => <div key={i} className="mb-2 h-8 animate-pulse rounded-lg bg-raised" />)}
      <div className="text-[13px] text-ink-2">{label}</div>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <Card className="text-center">
      {icon && <div className="mb-2 flex justify-center text-pos">{icon}</div>}
      <div className="text-[17px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 text-[13px] text-ink-2">{children}</div>}
    </Card>
  );
}

export function ErrorBar({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-neg-bg px-4 py-3 text-[14px] text-neg" role="alert">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry} className="font-semibold">Retry</button>}
    </div>
  );
}

/** "this week: PTS +12.5 pp, REB +8.0 pp" -> "Gains PTS +12.5 · REB +8.0" (the costs and season effects are on the detail page). */
export function gainsLine(m: MoveSuggestion): string | null {
  const wk = m.reasons.find((r) => r.startsWith("this week:"));
  if (!wk) return null;
  const parts = wk.slice("this week:".length).split(",").map((x) => x.trim().replace(/\s*pp$/, "")).filter(Boolean);
  return parts.length ? `Gains ${parts.join(" · ")}` : null;
}

const KIND: Record<MoveSuggestion["kind"], { tone: Tone }> = { season: { tone: "pos" }, stream: { tone: "brand" }, injury: { tone: "warn" } };

/** Move card: type tag, the add (team · pos · % owned · drop), this week vs rest of season, gains, actions. */
export function MoveCard({ m, note, detailsHref, onDid, compact = false, tagNote }: { m: MoveSuggestion; note?: string; detailsHref?: string; onDid?: () => void; compact?: boolean; tagNote?: string }) {
  const meta = [m.add.team, m.add.positions, m.add.pctOwned != null ? `${Math.round(m.add.pctOwned)}% owned` : null, m.ilMove ? `${m.ilMove.name} to IL` : m.drop ? `Drop ${m.drop.name}` : "Open spot"].filter(Boolean).join(" · ");
  return (
    <Card className="p-5" data-testid="move-card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND[m.kind].tone}>{m.label}</Badge>
        {tagNote && <span className="text-[13px] text-ink-2">{tagNote}</span>}
        {compact && detailsHref && <Link href={detailsHref} className="text-[14px] text-brand">Details ›</Link>}
      </div>
      <div className="mt-2.5 text-[22px] font-semibold leading-tight text-ink">{m.add.name}</div>
      <div className="mt-1 text-[14px] text-ink-2">{meta}</div>
      <div className="mt-3 grid grid-cols-2 gap-4">
        <div>
          <Label className="text-ink-2">This week</Label>
          <Delta v={m.dWeek} className="text-[24px]" />
        </div>
        <div>
          <Label className="text-ink-2">Rest of season</Label>
          <Delta v={m.dRos} className="text-[24px]" />
        </div>
      </div>
      {!compact && (
        <>
          {(note ?? gainsLine(m)) && <div className="mt-3 text-[13px] text-ink-2">{note ?? gainsLine(m)}</div>}
          {m.blocked && <div className="mt-2 text-[13px] text-warn">{m.blocked}</div>}
          <div className="mt-4 grid grid-cols-2 gap-2">
            {onDid && <Button onClick={onDid} disabled={!!m.blocked} title="Records the move you made on Yahoo (counts as an add)">I did this</Button>}
            {detailsHref && <LinkButton href={detailsHref}>Details <IconExternal /></LinkButton>}
          </div>
        </>
      )}
    </Card>
  );
}
