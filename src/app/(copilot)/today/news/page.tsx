"use client";

import { useSeason } from "@/ui/season-data";
import { Label, PageTitle } from "@/ui/kit";
import { AlertList, NewsList } from "@/ui/today-parts";

export default function NewsPage() {
  const { data: d } = useSeason();
  if (!d) return null;
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <PageTitle title="Alerts & news" back={{ href: "/today", label: "Today" }} meta={`${d.alerts.length} alert${d.alerts.length === 1 ? "" : "s"}`} />
      {d.alerts.length > 0 && <div><Label className="mb-2">Alerts</Label><AlertList d={d} /></div>}
      <div><Label className="mb-2">News for my players</Label><NewsList d={d} /></div>
    </div>
  );
}
