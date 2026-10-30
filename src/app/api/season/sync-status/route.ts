import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getSyncStatus } from "@/server/season-ingest";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** What the last autonomous sync did, per part, plus the counts the overlay and /season show. */
export async function GET(req: Request) {
  try {
    return withCors(req, NextResponse.json(getSyncStatus(getDb()), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
