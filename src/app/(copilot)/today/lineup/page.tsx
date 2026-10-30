"use client";

import { useSeason } from "@/ui/season-data";
import { Badge, LinkButton, PageTitle } from "@/ui/kit";
import { LineupList } from "@/ui/today-parts";

export default function LineupPage() {
  const { data: d } = useSeason();
  if (!d) return null;
  return (
    <div className="mx-auto max-w-xl">
      <PageTitle title="Today’s lineup" back={{ href: "/today", label: "Today" }} meta={`${d.lineup.gamesToday} of your players play today · ${d.lineup.starters.length}/${d.league.settings.rosterSlots.length} slots`} />
      <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-2"><Badge tone="pos">● Plays today</Badge>Gray dot · no game</div>
      <LineupList d={d} />
      <LinkButton href="/today/checklist" className="mt-6 w-full">Bench, IL & Yahoo checklist →</LinkButton>
    </div>
  );
}
