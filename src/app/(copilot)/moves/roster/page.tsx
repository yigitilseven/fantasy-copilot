"use client";

import { useEffect, useState } from "react";
import { api, useReport, useSeason } from "@/ui/season-data";
import { Card, DeltaPill, EmptyState, ErrorBar, Label, PageTitle, PlayerRow, Segmented, StatusBadge } from "@/ui/kit";
import { SortMenu } from "@/ui/moves-parts";
import { ago } from "@/ui/format";
import type { FaPool } from "@/server/season-fa-pool";

type Pos = "all" | "PG" | "SG" | "SF" | "PF" | "C";
type FaSort = "value" | "games" | "owned";
const FA_SORT: Record<FaSort, string> = { value: "Value", games: "Games this week", owned: "% owned" };
const POS: { value: Pos; label: string }[] = ["all", "PG", "SG", "SF", "PF", "C"].map((v) => ({ value: v as Pos, label: v === "all" ? "All" : v }));

export default function RosterDecisionsPage() {
  const { data: d, sync } = useSeason();
  const report = useReport();
  const [pos, setPos] = useState<Pos>("all");
  const [sort, setSort] = useState<FaSort>("value");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [pool, setPool] = useState<FaPool | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams({ sort, limit: "50" });
    if (pos !== "all") p.set("pos", pos);
    if (dq.trim()) p.set("q", dq.trim());
    api<FaPool>(`/api/season/free-agents?${p}`)
      .then((r) => { if (alive) { setPool(r); setErr(null); } })
      .catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [pos, sort, dq]);

  if (!d) return null;
  const r = report.data;
  const syncedAt = d.freshness.freeAgents.at;
  return (
    <div className="mx-auto max-w-xl space-y-4 pt-2" data-testid="moves-roster">
      <PageTitle title="Who makes room?" back={{ href: "/moves", label: "Moves" }} meta="Sorted cheapest to cut" />
      {report.error && <ErrorBar message={report.error} />}
      {!r && !report.error && <Card className="text-[14px] text-ink-2">Loading roster report…</Card>}
      {r && (
        <>
          <Card>
            <Label>Drop candidates</Label>
            {r.drops.length === 0 && <div className="mt-2 text-[14px] text-ink-2">No drop candidates.</div>}
            {r.drops.map((x) => (
              <div key={x.playerId} className="border-b border-rule py-2.5 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0"><div className="truncate text-[16px] text-ink">{x.name}</div><div className="text-[12.5px] text-ink-3">{x.team} · {x.positions}</div></div>
                  <DeltaPill v={x.dWin} />
                </div>
                {x.note && <div className="mt-1 text-[13px] text-ink-2">{x.note}</div>}
              </div>
            ))}
          </Card>
          {r.holds.length > 0 && (
            <Card>
              <Label>Hold</Label>
              {r.holds.map((x) => <div key={x.playerId} className="py-1.5 text-[15px] text-ink"><span className="font-medium">{x.name}</span> <span className="text-ink-2">· {x.reason}</span></div>)}
            </Card>
          )}
        </>
      )}

      <div className="pt-2">
        <h2 className="text-[30px] leading-tight text-ink">Free-agent pool</h2>
        <div className="text-[14px] text-ink-2">{pool ? `${pool.count} players · ${pool.source === "captured" ? "Yahoo" : "all unrostered"}` : "Loading…"}{syncedAt ? ` · Synced ${ago(syncedAt)}` : sync?.lastAttemptAt ? ` · Synced ${ago(sync.lastAttemptAt)}` : ""}</div>
      </div>
      <Card className="space-y-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search player name" aria-label="Search player name" className="min-h-11 w-full rounded-xl bg-raised px-3 text-[15px] text-ink placeholder:text-ink-3 focus:outline-none" />
        <Segmented value={pos} options={POS} onChange={setPos} />
        <div className="flex items-center justify-between text-[13px] text-ink-2"><span>Sort</span><SortMenu value={sort} labels={FA_SORT} onChange={setSort} /></div>
        {err && <ErrorBar message={err} />}
        {pool && pool.players.length === 0 && <EmptyState title="No players match" />}
        <div>
          {pool?.players.map((p) => (
            <PlayerRow
              key={p.playerId}
              name={p.name}
              sub={<>{p.team} · {p.positions}{p.status.flag !== "healthy" && <> · <StatusBadge flag={p.status.flag} detail={p.status.detail} /></>}</>}
              right={<div className="fc-num shrink-0 text-right text-[12.5px] text-ink-2">{p.gamesThisWeek} game{p.gamesThisWeek === 1 ? "" : "s"}{p.pctOwned != null ? ` · ${Math.round(p.pctOwned)}%` : ""}</div>}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
