import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { recordSyncReport, syncReportBody } from "@/server/season-ingest";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript reports how a sync run went (per part), for the overlay/app status chips. */
export async function POST(req: Request) {
  try {
    const body = syncReportBody.parse(await readJson(req));
    recordSyncReport(getDb(), body);
    return withCors(req, NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
