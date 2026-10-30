"use client";

import { Card } from "@/ui/kit";
import { LeaguePage, PowerList } from "@/ui/league-parts";

export default function PowerPage() {
  return (
    <LeaguePage testid="league-power-page" title="The league, ranked." meta="Power = average win% vs everyone">
      {(r) => (
        <>
          <Card className="px-3 py-3"><PowerList teams={r.teams} /></Card>
          <p className="mt-3 text-[13.5px] text-ink-2">Games are the expected player-games in an average week. Rankings compare category matchups, not raw point totals.</p>
        </>
      )}
    </LeaguePage>
  );
}
