import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { SeasonError } from "@/db/season";
import { computeSeasonReport } from "@/server/season-report";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** League analysis: team projections and ranks, head-to-head odds, depth, moves. */
export async function GET(req: Request) {
  try {
    const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const r = computeSeasonReport(getDb(), { date: q.date });
    if (!r) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet: run `pnpm season:init --draft=<id>` first");
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
