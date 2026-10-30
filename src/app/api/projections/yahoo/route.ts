import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ingestYahooProjections, yahooProjectionStatus } from "@/integrations/yahoo/projections";
import { invalidateRecommendationCaches } from "@/server/recommendations";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stat = z.number().finite().nullable().optional();
const pct = z.number().min(0).max(1).nullable().optional();
const row = z.object({
  yahooId: z.string().regex(/^\d{1,12}$/),
  playerName: z.string().trim().min(1).max(120),
  nbaTeam: z.string().max(10).optional(),
  positions: z.string().max(40).optional(),
  injuryTag: z.string().max(10).optional(),
  xrank: stat,
  rank: stat,
  adp: stat,
  gp: z.number().min(0).max(120).nullable().optional(),
  fgPct: pct,
  ftPct: pct,
  threePm: stat,
  pts: stat,
  reb: stat,
  ast: stat,
  stl: stat,
  blk: stat,
  tov: stat,
});
const body = z.object({ season: z.literal("2026-27"), view: z.literal("proj"), rows: z.array(row).max(1000) });

export function OPTIONS(req: Request) {
  return preflight(req);
}

/**
 * Yahoo's 2026-27 projections as shown in the draft room's Players tab ("2026-27 Proj Stats", season totals), sent by the
 * userscript (read-only on Yahoo). Idempotent upserts by Yahoo id; matched / created players are reported.
 */
export async function POST(req: Request) {
  try {
    const b = body.parse(await readJson(req));
    const summary = ingestYahooProjections(getDb(), b.rows, { season: b.season });
    invalidateRecommendationCaches();
    return withCors(req, NextResponse.json({ ...summary, status: yahooProjectionStatus(getDb()) }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

export async function GET(req: Request) {
  return withCors(req, NextResponse.json(yahooProjectionStatus(getDb()), { headers: { "Cache-Control": "no-store" } }));
}
