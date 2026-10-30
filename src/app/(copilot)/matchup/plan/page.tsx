"use client";

import Link from "next/link";
import { catTone, catWord, pct, pp } from "@/ui/format";
import { Badge, Card, cx, EmptyState, Label, MoreLink, PageTitle } from "@/ui/kit";
import { defendCats, movesForCats } from "@/ui/matchup-parts";
import { useSeason } from "@/ui/season-data";
import { fivePlan } from "@/ui/today-parts";

const WORD_TEXT = { pos: "text-pos", warn: "text-warn", neg: "text-neg", neutral: "text-ink-2" } as const;

export default function PlanPage() {
  const { data: d } = useSeason();
  if (!d) return null;
  const w = d.week;
  const f = fivePlan(w.cats);
  const defend = defendCats(w.cats, w.matchupCaptured);
  const moves = movesForCats(d.moves.items, f.chase);
  const noAdds = w.addsRemaining <= 0;
  return (
    <div className="mx-auto max-w-5xl">
      <PageTitle title="Protect. Then push." back={{ href: "/matchup", label: "Matchup" }} meta="Defense and adds plan" />
      <div className="grid gap-4 md:grid-cols-2 md:gap-6">
        <div className="space-y-4">
          <Card className="p-5" data-testid="five-plan">
            <Label>Win five or six</Label>
            <div className="mt-3 space-y-2 text-[18px]">
              <div className="text-warn">Chase: {f.chase.join(", ") || "–"}</div>
              <div className="text-pos">Protect: {f.protect.join(", ") || "–"}</div>
              <div className="text-ink-2">Concede: {f.concede.join(", ") || "–"}</div>
            </div>
            <div className="mt-3 text-[12px] text-ink-2">Won ≥85% · Swing 35–65% · Lost ≤15%. TO is lower-is-better.</div>
          </Card>
          <Card className="p-4" data-testid="defend">
            <Label>What to defend</Label>
            {defend.length === 0 ? (
              <div className="mt-2 text-[14px] text-ink-2">Nothing at risk: no category you lead is under 85%.</div>
            ) : (
              <ul className="mt-1">
                {defend.map((c) => {
                  const t = catTone(c.p);
                  return (
                    <li key={c.cat} className="flex items-center justify-between gap-3 border-b border-rule py-2.5 last:border-b-0">
                      <span className="text-[15px] font-semibold text-ink">{c.cat}</span>
                      <span className="text-[13px] text-ink-2">{w.matchupCaptured ? "you lead" : "favored"} · could lose it</span>
                      <span className={cx("fc-num text-[14px]", WORD_TEXT[t])}>{pct(c.p)} <span className="text-[11px]">{catWord(c.p)}</span></span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label>Adds plan · chase {f.chase.join(", ") || "–"}</Label>
            <Badge tone={noAdds ? "neg" : "neutral"}>{w.addsRemaining} of {w.addsLimit} adds left</Badge>
          </div>
          {noAdds && <div className="rounded-xl bg-warn-bg px-4 py-3 text-[14px] text-warn" data-testid="no-adds">No adds left this week. These moves are for next week or if you correct the adds used.</div>}
          {f.chase.length === 0 && <EmptyState title="No swing categories">Every category is leaning or decided, so there is nothing to chase with adds.</EmptyState>}
          {f.chase.length > 0 && moves.length === 0 && <EmptyState title="No move helps these categories">No suggested add improves {f.chase.join(", ")} this week.</EmptyState>}
          {moves.map(({ m, helps }) => (
            <Card key={`${m.add.playerId}-${m.drop?.playerId ?? m.ilMove?.playerId ?? "spot"}`} className="p-4" data-testid="plan-move">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[17px] font-semibold text-ink">{m.add.name}</div>
                  <div className="text-[13px] text-ink-2">{[m.add.team, m.add.positions, `${m.add.games} games`, m.ilMove ? `${m.ilMove.name} to IL` : m.drop ? `Drop ${m.drop.name}` : "Open spot"].join(" · ")}</div>
                </div>
                <span className="fc-num text-[18px] font-semibold text-pos">{pp(m.dWeek)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {helps.map((c) => <Badge key={c} tone="warn">{c}</Badge>)}
                <span className="text-[12.5px] text-ink-2">{m.label}</span>
              </div>
              {m.blocked && <div className="mt-2 text-[13px] text-warn">{m.blocked}</div>}
              <Link href={`/moves/${encodeURIComponent(m.add.playerId)}`} className="mt-2 inline-block text-[14px] text-brand">Details ›</Link>
            </Card>
          ))}
          <MoreLink href="/moves" className="pt-1">All suggested moves</MoreLink>
        </div>
      </div>
    </div>
  );
}
