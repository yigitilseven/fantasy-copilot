import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { ingestMatchup, matchupBody } from "@/server/season-ingest";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript posts the current week's category totals of both teams from Yahoo's Matchup page. */
export async function POST(req: Request) {
  try {
    const body = matchupBody.parse(await readJson(req));
    return withCors(req, NextResponse.json(ingestMatchup(getDb(), body), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
