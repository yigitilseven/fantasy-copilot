"use client";

import Link from "next/link";
import { useReport, useSeason } from "@/ui/season-data";
import { Badge, Card, ErrorBar, Label, Skeleton } from "@/ui/kit";
import { Activity, CatBenchmarks, CatStrip, DepthTable, H2HList, headline, LeagueNav, LinkList, Notes, PowerBadge, PowerList, StatTiles, SummaryCard, TeamsLegend, TeamsTable } from "@/ui/league-parts";

const More = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="text-[13.5px] text-brand">{children}</Link>;

/** League overview. Phone: headline, engine summary, stats, links to the sub-pages. Desktop: the whole league on one screen. */
export default function LeaguePage() {
  const { data: r, error, loading } = useReport();
  const { data: d, reload } = useSeason();
  if (error) return <div className="pt-6"><ErrorBar message={error} onRetry={reload} /></div>;
  if (!r) return <div className="pt-6"><Skeleton lines={5} label={loading ? "Analysing the league…" : "Loading…"} /></div>;
  const sub = d ? `${d.league.name} · ${d.league.teams}-team H2H · 9-category` : "9-category H2H";
  return (
    <div data-testid="league-tab">
      {/* ---------------- phone ---------------- */}
      <div className="space-y-4 pb-2 md:hidden">
        <div className="mt-2">
          <h1 className="text-[34px] leading-tight tracking-tight">{headline(r)}</h1>
          <div className="mt-1 text-[14.5px] text-ink-2">{sub}</div>
        </div>
        <div className="flex items-center justify-between"><Badge className="px-3 py-1.5 text-[14px]">Engine summary</Badge><PowerBadge r={r} /></div>
        <SummaryCard r={r} />
        <StatTiles r={r} />
        <Label>Your categories</Label>
        <CatStrip cats={r.cats} />
        <LinkList r={r} />
        <Notes r={r} />
      </div>

      {/* ---------------- desktop ---------------- */}
      <div className="hidden space-y-6 pt-6 md:block">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[44px] leading-tight tracking-tight">{headline(r)}</h1>
            <div className="mt-1 text-[14.5px] text-ink-2">League intelligence · category leverage, not a points race.</div>
          </div>
          <PowerBadge r={r} />
        </div>
        <LeagueNav />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-3">
            <Label>Engine summary</Label>
            <SummaryCard r={r} />
            <StatTiles r={r} />
          </div>
          <CatStrip cats={r.cats} />
        </div>
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="text-[22px]">Teams × 9 categories</h2><TeamsLegend /></div>
          <TeamsTable teams={r.teams} />
        </Card>
        <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
          <Card className="p-5"><div className="mb-3 flex items-baseline justify-between"><h2 className="text-[22px]">Power rankings</h2><More href="/league/power">Open</More></div><PowerList teams={r.teams} /></Card>
          <Card className="p-5"><div className="mb-3 flex items-baseline justify-between"><h2 className="text-[22px]">Category benchmarks</h2><More href="/league/categories">Open</More></div><CatBenchmarks cats={r.cats} /><div className="mt-3 text-[12.5px] text-ink-3">TO: lower is better. Values are weekly projections.</div></Card>
          <Card className="p-5 md:col-span-2 xl:col-span-1"><div className="mb-3 flex items-baseline justify-between"><h2 className="text-[22px]">H2H · Hardest first</h2><More href="/league/h2h">Open</More></div><H2HList rows={r.h2h} /></Card>
        </div>
        <div className="grid items-start gap-6 md:grid-cols-2">
          <Card className="p-5"><div className="mb-3 flex items-baseline justify-between"><h2 className="text-[22px]">Position depth</h2><Badge>IL {r.ilUsed}/{r.ilSlots}</Badge></div><DepthTable rows={r.depth} /></Card>
          <Card className="p-5"><div className="mb-3 flex items-baseline justify-between"><h2 className="text-[22px]">League activity</h2><More href="/league/depth">Open</More></div><Activity limit={6} /></Card>
        </div>
        <Notes r={r} />
      </div>
    </div>
  );
}
