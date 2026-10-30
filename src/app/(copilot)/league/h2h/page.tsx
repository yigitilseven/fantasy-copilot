"use client";

import { Card } from "@/ui/kit";
import { H2HList, LeaguePage } from "@/ui/league-parts";

export default function H2HPage() {
  return (
    <LeaguePage testid="league-h2h-page" title="The hard matchups first." meta="Average week · expected categories out of 9">
      {(r) => (
        <Card className="px-4 py-3"><H2HList rows={r.h2h} /></Card>
      )}
    </LeaguePage>
  );
}
