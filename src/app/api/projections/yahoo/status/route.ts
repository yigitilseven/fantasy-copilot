import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { yahooProjectionStatus } from "@/integrations/yahoo/projections";
import { preflight, withCors } from "../../../_cors";
import { errorResponse } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** { count, matched, created, usable, season, capturedAt } of the captured Yahoo 2026-27 projections. */
export async function GET(req: Request) {
  try {
    return withCors(req, NextResponse.json(yahooProjectionStatus(getDb()), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
