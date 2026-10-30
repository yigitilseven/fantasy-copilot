import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { maybeKickNewsRefresh, newsStatusResponse } from "@/server/news";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Last news/injury update: per-source ok/error + timestamps. Also kicks a background refresh when stale (> 6 h). */
export async function GET(req: Request) {
  try {
    const db = getDb();
    maybeKickNewsRefresh(db);
    return withCors(req, NextResponse.json(newsStatusResponse(db), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
