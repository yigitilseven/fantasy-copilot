"use client";

import { useSeason } from "@/ui/season-data";
import { Card, PageTitle } from "@/ui/kit";
import { BenchList, YahooChecklist } from "@/ui/today-parts";

export default function ChecklistPage() {
  const { data: d } = useSeason();
  if (!d) return null;
  const freeIl = d.league.settings.ilSlots - d.lineup.il.length;
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <PageTitle title="Finish in Yahoo" back={{ href: "/today/lineup", label: "Lineup" }} meta="Bench, IL & manual actions" />
      <YahooChecklist d={d} />
      <BenchList d={d} />
      {freeIl > 0 && <Card className="p-4 text-[14px]"><div className="text-ink">IL · {freeIl} open spot{freeIl > 1 ? "s" : ""}</div><div className="mt-1 text-ink-2">Park a player who is out long-term there to free a roster spot.</div></Card>}
    </div>
  );
}
