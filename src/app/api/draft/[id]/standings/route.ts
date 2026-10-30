import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { computeStandings } from "@/server/recommendations";
import { computeH2hTable } from "@/server/standings";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/**
 * Standings analysis (engine/standings-opt): candidate gains for the "Roto" score dimension and the projected finish (roto rank per Yahoo
 * view + weekly H2H outlook) of the current draft state. ?table=1 returns the round-robin H2H table of the CURRENT rosters instead
 * (mock-draft summary).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const draftId = parseId((await ctx.params).id);
    const db = getDb();
    const table = new URL(req.url).searchParams.get("table") === "1";
    const body = table ? computeH2hTable(db, draftId) : computeStandings(db, draftId);
    if (!body) return withCors(req, NextResponse.json({ error: `Draft ${draftId} not found`, code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
