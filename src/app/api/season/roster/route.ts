import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { SeasonError, getLeague, getRosters, getTeams, recordAdds, syncTeamRoster } from "@/db/season";
import { weekStartOf, gameDayOf } from "@/engine/season/schedule";
import { ingestRoster, rosterBody } from "@/server/season-ingest";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript posts a Yahoo My Team / team roster page here (best-effort parse; see extension/README.md). */
export async function POST(req: Request) {
  try {
    const body = rosterBody.parse(await readJson(req));
    const db = getDb();
    const r = ingestRoster(db, body);
    resetSeasonPlayerCache(db);
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

const moveBody = z.object({
  /** Player ids (local) that joined / left the user's team on Yahoo ("I made this move"). */
  add: z.string().optional(),
  drop: z.string().optional(),
  il: z.string().optional(),
  activate: z.string().optional(),
});

/** Manual roster edit after acting on Yahoo: add/drop/IL/activate for the user's team. Counts an add for the weekly limit. */
export async function PATCH(req: Request) {
  try {
    const body = moveBody.parse(await readJson(req));
    const db = getDb();
    const lg = getLeague(db);
    if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
    const mine = (getRosters(db, lg.id).get(lg.userSlot) ?? []).map((r) => ({ playerId: r.playerId, lineupSlot: r.lineupSlot, status: r.status }));
    let next = mine.filter((r) => r.playerId !== body.drop);
    if (body.il) next = next.map((r) => (r.playerId === body.il ? { ...r, lineupSlot: "IL", status: "il" as const } : r));
    if (body.activate) next = next.map((r) => (r.playerId === body.activate ? { ...r, lineupSlot: "BN", status: "bench" as const } : r));
    if (body.add && !next.some((r) => r.playerId === body.add)) next.push({ playerId: body.add, lineupSlot: "BN", status: "bench" });
    if (next.length === mine.length && !body.il && !body.activate && !body.add && !body.drop) throw new SeasonError("INVALID", "Nothing to change");
    const res = syncTeamRoster(db, lg.id, lg.userSlot, next, "manual");
    if (res.added.length) recordAdds(db, lg.id, weekStartOf(gameDayOf(Date.now(), lg.settings.timezone)), res.added, "manual");
    resetSeasonPlayerCache(db);
    return withCors(req, NextResponse.json({ ...res, team: getTeams(db, lg.id).find((t) => t.isUser)?.name }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
