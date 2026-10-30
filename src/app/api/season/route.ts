import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { computeSeason } from "@/server/season";
import { kickDailyRefresh } from "@/server/season-daily";
import { preflight, withCors } from "../_cors";
import { errorResponse } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), moves: z.coerce.number().int().min(1).max(20).optional() });

/** Season overview: today's lineup, this week's matchup, best add/drop moves, alerts, news for my players, data freshness. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = query.parse(Object.fromEntries(url.searchParams));
    const db = getDb();
    kickDailyRefresh(db);
    const o = computeSeason(db, { date: q.date, moveLimit: q.moves });
    if (!o) return withCors(req, NextResponse.json({ error: "No season league yet. Run `pnpm season:init --draft=<id>`.", code: "LEAGUE_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json(o, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
