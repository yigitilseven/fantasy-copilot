"use client";

import { rangeLabel } from "@/ui/format";
import { Card, Gauge, Label, LinkButton, PageTitle, ProbHero } from "@/ui/kit";
import { AddsEditor, CatTable2, leverCat, movesForCats, ScoreCard } from "@/ui/matchup-parts";
import { useSeason } from "@/ui/season-data";

export default function MatchupPage() {
  const { data: d, setAddsUsed } = useSeason();
  if (!d) return null;
  const w = d.week;
  const lever = leverCat(w.cats);
  const helper = lever ? movesForCats(d.moves.items, [lever.cat])[0] : null;
  const total = w.youGames + w.oppGames;
  return (
    <div className="mx-auto max-w-5xl">
      <PageTitle title="Matchup" meta={`${w.number ? `Week ${w.number} · ` : ""}${rangeLabel(w.start, w.end)} · ${w.daysLeft} days left`} />
      <div className="grid gap-4 md:grid-cols-2 md:gap-6">
        <div className="space-y-4">
          <ProbHero p={w.winProb} opponent={w.opponent} />
          <div data-testid="games-left">
            <div className="mt-1 flex justify-between text-[15px]">
              <span className="text-brand">You · <span className="fc-num">{w.youGames.toFixed(1)}</span> games left</span>
              <span className="text-ink-2">{w.opponent ?? "Opponent"} · <span className="fc-num">{w.oppGames.toFixed(1)}</span></span>
            </div>
            {total > 0 && <Gauge p={w.youGames / total} className="mt-2 h-[3px]" />}
          </div>
          <ScoreCard week={w} />
          {lever && (
            <Card className="p-4" data-testid="lever">
              <Label className="text-warn">The lever</Label>
              <div className="mt-1.5 text-[15.5px] leading-snug text-ink">
                {lever.cat} is the most open category{lever.p >= 0.35 && lever.p <= 0.65 ? " (a swing)" : ""}.
                {helper ? ` ${helper.m.add.name} helps it most this week.` : ""}
              </div>
            </Card>
          )}
          <LinkButton href="/matchup/plan" className="w-full">Defense & adds plan →</LinkButton>
        </div>
        <div className="space-y-4">
          <CatTable2 cats={w.cats} opponent={w.opponent} captured={w.matchupCaptured} />
          <AddsEditor week={w} onSet={setAddsUsed} />
        </div>
      </div>
    </div>
  );
}
