"use client";

import { useState } from "react";
import { useSeason } from "@/ui/season-data";
import { Button, Card, PageTitle } from "@/ui/kit";
import { BriefBlocks, BriefSourceBadge, OutdatedNote, parseBrief } from "@/ui/today-parts";
import { dayLabel } from "@/ui/format";
import { AnalysisFallbackBanner } from "@/ui/states";

/** The full morning text, in two halves on a phone: the decisions first, then risks and the rest. */
export default function BriefPage() {
  const { brief, data } = useSeason();
  const [page, setPage] = useState(0);
  if (!brief) return <Card className="p-5 text-ink-2">No brief yet today. It is written every morning at the brief time (Settings).</Card>;
  const blocks = parseBrief(brief.text);
  const cut = Math.min(blocks.length, brief.weekly ? 3 : 3);
  const pages = blocks.length > cut ? [blocks.slice(0, cut), blocks.slice(cut)] : [blocks];
  const at = brief.at ? new Date(brief.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="mx-auto max-w-xl">
      <PageTitle title={brief.weekly ? "Your week plan" : "Your morning edge"} back={{ href: "/today", label: "Today" }} meta={`${brief.weekly ? "Weekly plan" : "Daily brief"} · ${data ? dayLabel(data.date) : ""}${at ? `, ${at}` : ""}`} />
      <div className="mb-4 flex items-center gap-2 text-[13px] text-ink-2">
        <BriefSourceBadge b={brief} />
        {pages.length > 1 && <span>{page + 1} of {pages.length} · {page === 0 ? "Decisions" : "Risks & rationale"}</span>}
        {brief.note && <span>· {brief.note}</span>}
      </div>
      {brief.outdated && <div className="mb-4"><OutdatedNote /></div>}
      {!brief.usedClaude && <AnalysisFallbackBanner className="mb-4" />}
      {/* phones page through; wide screens show everything */}
      <div className="md:hidden"><BriefBlocks blocks={pages[page]} /></div>
      <div className="hidden md:block"><BriefBlocks blocks={blocks} /></div>
      {pages.length > 1 && (
        <Button className="mt-4 w-full md:hidden" onClick={() => { setPage(page === 0 ? 1 : 0); window.scrollTo({ top: 0 }); }}>
          {page === 0 ? "Continue to risks & rationale →" : "← Back to decisions"}
        </Button>
      )}
    </div>
  );
}
