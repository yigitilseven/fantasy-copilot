"use client";

import { Card } from "@/ui/kit";
import { LeaguePage, TeamsLegend, TeamsTable } from "@/ui/league-parts";

export default function TeamsPage() {
  return (
    <LeaguePage testid="league-teams" wide title="Compare the field." meta="Teams × 9 category projections">
      {(r) => (
        <>
          <div className="mb-3"><TeamsLegend /></div>
          <Card className="p-4"><TeamsTable teams={r.teams} /></Card>
          <p className="mt-3 text-[13.5px] text-ink-2">Weekly projections, sorted by power. Swipe inside the table for all 9 categories. TO: lower is better.</p>
        </>
      )}
    </LeaguePage>
  );
}
