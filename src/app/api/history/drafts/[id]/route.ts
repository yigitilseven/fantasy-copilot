import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { listDraftSummaries, loadAnalysisDraft, loadStandings, loadTeams } from "@/db/history";
import { getAllPlayerRecords } from "@/db/repository";
import { PLAYER_MAP, pickDeviations, teamLabel } from "@/engine/analysis";
import { loadAnalysisInputs } from "@/server/history-analysis";
import { errorResponse, parseId } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One draft: the board grid (every pick with ADP, deviation), teams, the user's roster and the standings tables. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await ctx.params).id);
    const db = getDb();
    const draft = loadAnalysisDraft(db, id);
    if (!draft) return NextResponse.json({ error: "Draft not found", code: "DRAFT_NOT_FOUND" }, { status: 404 });
    const summary = listDraftSummaries(db).find((s) => s.id === id)!;
    const { players } = loadAnalysisInputs(db);
    const map = PLAYER_MAP(players);
    const recs = new Map(getAllPlayerRecords(db).map((r) => [r.player.id, r.player.nbaTeam]));
    const devs = new Map(pickDeviations([draft], map).map((d) => [d.pick, d]));
    const picks = draft.picks.map((k) => {
      const p = map.get(k.playerId);
      const dv = devs.get(k.pick);
      return {
        pick: k.pick, round: k.round, teamSlot: k.teamSlot, teamName: teamLabel(draft, k.teamSlot), playerId: k.playerId,
        name: p?.name ?? k.playerId, positions: p?.positions.join("/") ?? "", nbaTeam: recs.get(k.playerId) ?? "",
        adp: dv?.adp ?? null, deviation: dv?.deviation ?? null, z: dv?.z ?? null, isUser: k.teamSlot === draft.userSlot,
      };
    });
    const teams = Array.from({ length: draft.teams }, (_, i) => ({ slot: i + 1, name: teamLabel(draft, i + 1), isUser: i + 1 === draft.userSlot }));
    return NextResponse.json({ summary, teams, picks, standings: loadStandings(db, id), teamRows: loadTeams(db, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
