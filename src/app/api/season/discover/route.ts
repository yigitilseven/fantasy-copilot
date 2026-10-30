import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { discoverBody, ingestDiscovery } from "@/server/season-ingest";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript posts the team ids/names it found in the league navigation (read-only discovery). */
export async function POST(req: Request) {
  try {
    const body = discoverBody.parse(await readJson(req));
    const db = getDb();
    const r = ingestDiscovery(db, body);
    resetSeasonPlayerCache(db);
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
