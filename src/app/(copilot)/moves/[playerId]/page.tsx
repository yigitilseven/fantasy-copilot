"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSeason } from "@/ui/season-data";
import { Badge, Button, Card, Delta, EmptyState, ErrorBar, Label, LinkButton, PageTitle } from "@/ui/kit";
import { parseReasons } from "@/ui/moves-parts";
import { pp } from "@/ui/format";

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const KIND_TONE = { season: "pos", stream: "brand", injury: "warn" } as const;

export default function MoveDetailPage() {
  const { data: d, markMove } = useSeason();
  const params = useParams<{ playerId: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!d) return null;
  const id = safeDecode(String(params.playerId ?? ""));
  const m = d.moves.items.find((x) => x.add.playerId === id);
  if (!m) {
    return (
      <div className="mx-auto max-w-xl space-y-4 pt-2">
        <PageTitle title="Move not found" back={{ href: "/moves", label: "Moves" }} />
        <EmptyState title="This suggestion is no longer in the list">It may have been made, or the data changed.</EmptyState>
        <LinkButton href="/moves" className="w-full">Back to moves</LinkButton>
      </div>
    );
  }
  const { gains, costs, notes } = parseReasons(m.reasons);
  const meta = [m.add.team, m.add.positions, m.add.pctOwned != null ? `${Math.round(m.add.pctOwned)}% owned` : null, `${m.add.games} game${m.add.games === 1 ? "" : "s"} left this week`].filter(Boolean).join(" · ");
  const did = async () => {
    setBusy(true);
    setErr(null);
    try {
      await markMove(m);
      router.push("/moves");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-xl space-y-4 pt-2" data-testid="move-detail">
      <PageTitle title={m.kind === "season" ? "The balanced upgrade" : m.kind === "stream" ? "The weekly stream" : "The injury fix"} back={{ href: "/moves", label: "Moves" }} meta={m.add.name} />
      <Card className="p-5">
        <Badge tone={KIND_TONE[m.kind]}>{m.label}</Badge>
        <div className="mt-2.5 text-[24px] font-semibold leading-tight text-ink">{m.add.name}</div>
        <div className="mt-1 text-[14px] text-ink-2">{meta}</div>
        <div className="mt-3 text-[14px] text-ink">
          {m.ilMove ? `Move ${m.ilMove.name} to IL` : m.drop ? `Drop ${m.drop.name}` : "Uses an open roster spot"}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div><Label className="text-ink-2">This week</Label><Delta v={m.dWeek} className="text-[26px]" /></div>
          <div><Label className="text-ink-2">Rest of season</Label><Delta v={m.dRos} className="text-[26px]" /></div>
        </div>
        {m.blocked && <div className="mt-3 text-[13px] text-warn">{m.blocked}</div>}
        {err && <div className="mt-3"><ErrorBar message={err} /></div>}
        <Button className="mt-4 w-full" variant="primary" onClick={() => void did()} disabled={busy || !!m.blocked} title="Records the move you made on Yahoo (counts as an add)">{busy ? "Saving…" : "I did this"}</Button>
      </Card>
      {(gains.length > 0 || costs.length > 0) && (
        <Card className="space-y-3 p-5">
          <Label>Category-effect scores</Label>
          {gains.length > 0 && (
            <div className="flex flex-wrap items-center gap-2"><span className="w-12 text-[14px] text-pos">Gains</span>
              {gains.map((g) => <span key={g.cat + g.horizon} className="fc-num rounded-md bg-pos-bg px-2 py-1 text-[13px] text-pos">{g.cat} {pp(g.v)}</span>)}</div>
          )}
          {costs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2"><span className="w-12 text-[14px] text-neg">Costs</span>
              {costs.map((g) => <span key={g.cat + g.horizon} className="fc-num rounded-md bg-neg-bg px-2 py-1 text-[13px] text-neg">{g.cat} {pp(g.v)}</span>)}</div>
          )}
          <div className="text-[13px] text-ink-2">Change in the chance to win each category this week, in percentage points.</div>
        </Card>
      )}
      {notes.length > 0 && <Card className="space-y-1 p-5 text-[14px] text-ink">{notes.map((n) => <div key={n}>{n}</div>)}</Card>}
      {m.news.length > 0 && (
        <Card className="space-y-2 p-5"><Label>News</Label>{m.news.map((n) => <div key={n} className="text-[14px] text-ink">{n}</div>)}</Card>
      )}
      <p className="text-[13px] text-ink-2">Make the move in Yahoo, then tap “I did this.” This records a manual action, not an execution.</p>
    </div>
  );
}
