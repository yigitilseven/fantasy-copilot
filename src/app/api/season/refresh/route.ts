import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { runDailyRefresh } from "@/server/season-daily";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Runs the daily upkeep now (schedule if > 24 h old, news if > 6 h old, brief if missing) and waits for it. */
export async function POST(req: Request) {
  try {
    return withCors(req, NextResponse.json(await runDailyRefresh(getDb(), { force: true }), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
