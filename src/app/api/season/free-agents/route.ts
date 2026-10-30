import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { freeAgentsBody, ingestFreeAgents } from "@/server/season-ingest";
import { computeFaPool } from "@/server/season-fa-pool";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript posts the available players it reads on Yahoo's Players page (what you view + same-origin next pages). */
export async function POST(req: Request) {
  try {
    const body = freeAgentsBody.parse(await readJson(req));
    const db = getDb();
    const r = ingestFreeAgents(db, body);
    resetSeasonPlayerCache(db);
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

const query = z.object({
  pos: z.enum(["PG", "SG", "SF", "PF", "C"]).optional(),
  q: z.string().max(80).optional(),
  sort: z.enum(["value", "games", "owned"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** The scored free-agent pool: ?pos=PG&q=name&sort=value|games|owned&limit=50. */
export async function GET(req: Request) {
  try {
    const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const pool = computeFaPool(getDb(), q, { date: q.date });
    if (!pool) return withCors(req, NextResponse.json({ error: "No season league yet.", code: "LEAGUE_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json({ ...pool, players: pool.players }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
