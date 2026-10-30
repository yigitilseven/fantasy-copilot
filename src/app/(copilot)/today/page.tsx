"use client";

import Link from "next/link";
import { useSeason } from "@/ui/season-data";
import { rangeLabel } from "@/ui/format";
import { Badge, Card, CatGrid, Label, LinkButton, MoreLink, MoveCard, ProbHero } from "@/ui/kit";
import { AlertList, BriefCard, CatTable, FivePlan, LineupList, NewsList, NotificationCard, YahooChecklist, BenchList } from "@/ui/today-parts";
import { pp } from "@/ui/format";
import { PreseasonBanner } from "@/ui/states";

/** Today: one decision first (the top move), then the week's odds, the brief and today's lineup. Desktop: Lineup · Matchup · Moves. */
export default function TodayPage() {
  const { data: d, brief, markMove } = useSeason();
  if (!d) return null;
  const w = d.week;
  const top = d.moves.items[0];
  const weekLine = `${rangeLabel(w.start, w.end)} · ${w.daysLeft} day${w.daysLeft === 1 ? "" : "s"} left · Adds ${w.addsUsed}/${w.addsLimit} used (${w.addsRemaining} left)`;
  const topLabel = top ? `${top.ilMove ? `Move ${top.ilMove.name} to IL, add` : "Add"} ${top.add.name}${top.drop ? `, drop ${top.drop.name}` : ""} · ${pp(top.dWeek)}` : null;
  const playing = d.lineup.starters.length;
  const slots = d.league.settings.rosterSlots.length;
  const firstStart = d.lineup.changes.find((c) => c.type === "start");

  return (
    <div data-testid="today">
      {/* ---------------- phone ---------------- */}
      <div className="space-y-4 md:hidden">
        <NotificationCard />
        {d.seasonStarted === false && <PreseasonBanner firstGame={d.freshness.schedule.firstDate} />}
        <div className="flex items-end justify-between pt-2">
          <h1 className="text-[34px] tracking-tight">Today</h1>
          {w.number != null && <span className="fc-num text-[15px] tracking-[0.12em] text-ink-2">WEEK {String(w.number).padStart(2, "0")}</span>}
        </div>
        <ProbHero p={w.winProb} opponent={w.opponent} />
        <div className="text-[14.5px] text-ink-2">{weekLine}</div>
        {top && topLabel ? (
          <LinkButton href={`/moves/${encodeURIComponent(top.add.playerId)}`} variant="primary" className="w-full min-h-14 text-[16px]">{topLabel}</LinkButton>
        ) : (
          <Card className="p-4 text-[15px]">Hold: no move beats your current roster.</Card>
        )}
        <CatGrid cats={w.cats} />
        <BriefCard brief={brief} />
        <Card className="p-5">
          <div className="text-[16px] text-ink">{d.lineup.gamesToday} of your players play today · {playing}/{slots} slots</div>
          {firstStart && <div className="mt-1 text-[14px] text-ink-2">START {firstStart.name}{firstStart.toSlot ? ` at ${firstStart.toSlot}` : ""} · {firstStart.reason}</div>}
        </Card>
        <div className="flex items-center justify-between pb-2">
          <MoreLink href="/today/lineup">Lineup & Yahoo checklist</MoreLink>
          <MoreLink href="/today/news">Alerts & news</MoreLink>
        </div>
      </div>

      {/* ---------------- desktop ---------------- */}
      <div className="hidden gap-6 pt-6 md:grid md:grid-cols-2 xl:grid-cols-3">
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-[26px]">Lineup</h2><Badge>{playing}/{slots} slots</Badge></div>
          <div className="text-[14px] text-ink-2">{d.lineup.gamesToday} of your players play today</div>
          <Card className="px-4 py-3"><Label className="mb-1">Active · green dot = game today</Label><LineupList d={d} /></Card>
          <Card className="px-4 py-3"><BenchList d={d} /></Card>
          <YahooChecklist d={d} compact />
        </section>
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-[26px]">Matchup</h2>{w.number != null && <Badge>Week {w.number}</Badge>}</div>
          <Card className="p-5">
            <ProbHero p={w.winProb} opponent={w.opponent} size="md" />
            <div className="mt-3 text-[14px] text-ink-2">{weekLine}</div>
            <div className="mt-2 flex gap-10 text-[14px]"><span className="text-brand">You · {w.youGames} player-games</span><span className="text-ink-2">{w.opponent ?? "Opponent"} · {w.oppGames}</span></div>
            <div className="mt-4"><CatTable cats={w.cats} opponent={w.opponent} /></div>
          </Card>
          <FivePlan cats={w.cats} />
          <BriefCard brief={brief} />
        </section>
        <section className="space-y-4 md:col-span-2 xl:col-span-1">
          <div className="flex items-center justify-between"><h2 className="text-[26px]">Moves</h2><Badge>{d.moves.evaluated} checked</Badge></div>
          <div className="text-[14px] text-ink-2">{d.moves.faCount} free agents from Yahoo · {w.addsRemaining} adds left</div>
          {top && topLabel && <LinkButton href={`/moves/${encodeURIComponent(top.add.playerId)}`} variant="primary" className="w-full">{topLabel}</LinkButton>}
          {d.moves.items.slice(0, 3).map((m, i) => (
            <MoveCard key={m.add.playerId} m={m} tagNote={i === 0 ? "Best balanced add" : "Compare"} detailsHref={`/moves/${encodeURIComponent(m.add.playerId)}`} onDid={() => void markMove(m)} />
          ))}
          {d.moves.items.length === 0 && <Card className="p-4">Hold: no move beats your current roster.</Card>}
          <AlertList d={d} />
          <div><Label className="mb-2 text-neg">Player news</Label><NewsList d={d} limit={3} /></div>
          <Link href="/moves" className="block text-[14px] text-brand">All moves, drop candidates & FA pool →</Link>
        </section>
      </div>
    </div>
  );
}
