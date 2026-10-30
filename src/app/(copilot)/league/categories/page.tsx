"use client";

import { Card } from "@/ui/kit";
import { CatRows, LeaguePage } from "@/ui/league-parts";

export default function CategoriesPage() {
  return (
    <LeaguePage testid="league-categories" title="Know your shape." meta="Per-category projected weekly value">
      {(r) => (
        <>
          <p className="mb-2 text-[14.5px] text-ink-2">Value · rank of {r.teams.length} · best / median · average P(win)</p>
          <Card className="px-4 py-1"><CatRows cats={r.cats} /></Card>
          <p className="mt-3 text-[13.5px] text-ink-2">Bar length = rank strength; longer is better. TO ranks are reversed: lower is better.</p>
        </>
      )}
    </LeaguePage>
  );
}
