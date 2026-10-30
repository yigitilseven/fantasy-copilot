"use client";

import { EmptyState, ErrorBar, Skeleton } from "@/ui/kit";
import { LeaguePage, TradeCard, TradeChecker } from "@/ui/league-parts";
import { useSeason, useTrades } from "@/ui/season-data";

function Ideas() {
  const t = useTrades();
  const { reload } = useSeason();
  if (t.error) return <ErrorBar message={t.error} onRetry={reload} />;
  if (!t.data) return <Skeleton lines={3} label="Searching trades…" />;
  if (t.data.ideas.length === 0) return <EmptyState title="No trade clearly helps both sides">{t.data.evaluated} trades checked.</EmptyState>;
  return <div className="space-y-3">{t.data.ideas.map((i, k) => <TradeCard key={k} i={i} />)}</div>;
}

export default function TradesPage() {
  return (
    <LeaguePage testid="league-trades" title="Find a fair swap." meta="Both teams gain · avg weekly win chance over the next 3 weeks">
      {() => (
        <div className="space-y-4 md:grid md:grid-cols-[3fr_2fr] md:items-start md:gap-6 md:space-y-0">
          <Ideas />
          <TradeChecker />
        </div>
      )}
    </LeaguePage>
  );
}
