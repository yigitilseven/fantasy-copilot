"use client";

import { Badge, Card, Label } from "@/ui/kit";
import { Activity, DepthTable, InjuryList, LeaguePage } from "@/ui/league-parts";

export default function DepthPage() {
  return (
    <LeaguePage testid="league-depth-page" title={(r) => { const t = r.depth.find((d) => d.thin); return t ? `Mind the ${t.pos} depth.` : "Depth looks fine."; }} meta="Eligible players / dedicated slots">
      {(r) => {
        const thin = r.depth.filter((d) => d.thin);
        return (
          <div className="space-y-4 md:grid md:grid-cols-2 md:items-start md:gap-4 md:space-y-0">
            <div className="space-y-4">
              <Card className="px-4 py-3"><DepthTable rows={r.depth} /></Card>
              <div className={thin.length ? "text-[14.5px] text-warn" : "text-[14.5px] text-ink-2"}>
                {thin.length ? thin.map((d) => `${d.pos} thin: ${d.eligible} eligible for ${d.slots} slots.`).join(" ") : "No position is thin."} IL usage {r.ilUsed}/{r.ilSlots}.
              </div>
              <Card className="p-4"><div className="mb-2 flex items-center justify-between"><Label>Injuries</Label><Badge>IL {r.ilUsed}/{r.ilSlots}</Badge></div><InjuryList rows={r.injuries} /></Card>
            </div>
            <Card className="p-4"><Label className="mb-1">Recent league activity</Label><Activity limit={15} /></Card>
          </div>
        );
      }}
    </LeaguePage>
  );
}
