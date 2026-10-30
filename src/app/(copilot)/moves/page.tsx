"use client";

import { useMemo, useState } from "react";
import { useSeason } from "@/ui/season-data";
import { Card, EmptyState, LinkButton, MoveCard } from "@/ui/kit";
import { IconArrow } from "@/ui/icons";
import { SORT_LABEL, SortMenu, type MoveSort } from "@/ui/moves-parts";
import { AddLimitBanner } from "@/ui/states";

export default function MovesPage() {
  const { data: d } = useSeason();
  const [sort, setSort] = useState<MoveSort>("score");
  const items = useMemo(() => (d ? [...d.moves.items].sort((a, b) => b[sort] - a[sort]) : []), [d, sort]);
  if (!d) return null;
  const w = d.week;
  return (
    <div className="mx-auto max-w-xl space-y-4 pt-2" data-testid="moves">
      <div>
        <h1 className="text-[34px] leading-tight tracking-tight text-ink">Make one good move.</h1>
        <div className="mt-1 text-[15px] text-ink-2">{d.moves.faCount} free agents from {d.moves.faSource === "captured" ? "Yahoo" : "the player pool"} · {d.moves.evaluated} combos checked</div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[15px] text-ink-2">{w.addsRemaining} of {w.addsLimit} adds left this week</span>
        {items.length > 0 && <SortMenu value={sort} labels={SORT_LABEL} onChange={setSort} />}
      </div>
      {w.addsRemaining === 0 && <AddLimitBanner used={w.addsUsed} limit={w.addsLimit} />}
      {items.length === 0 ? (
        <EmptyState title="Hold: no move beats your current roster">Check back after the next Yahoo sync or injury news.</EmptyState>
      ) : (
        <div className="space-y-3">
          {items.map((m, i) => (
            <MoveCard key={`${m.add.playerId}-${m.drop?.playerId ?? m.ilMove?.playerId ?? i}`} m={m} compact detailsHref={`/moves/${encodeURIComponent(m.add.playerId)}`} />
          ))}
        </div>
      )}
      <p className="text-[14px] text-ink-2">All deltas are matchup win probability in pp. Compare this week with rest of season before acting.</p>
      <LinkButton href="/moves/roster" className="w-full min-h-14">Drop candidates, holds &amp; FA pool <IconArrow /></LinkButton>
      {d.moves.notes.length > 0 && <Card className="space-y-1 p-4 text-[13px] text-ink-2">{d.moves.notes.map((n) => <div key={n}>{n}</div>)}</Card>}
    </div>
  );
}
