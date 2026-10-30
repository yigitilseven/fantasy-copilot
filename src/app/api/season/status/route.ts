import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getLeague, lastYahooSync, loadFreeAgents } from "@/db/season";
import { FA_MAX_AGE_MS } from "@/server/season";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Light status for the userscript overlay ("roster synced 2m ago · 312 FAs") and its toggles. Cheap: no projections. */
export async function GET(req: Request) {
  try {
    const db = getDb();
    const lg = getLeague(db);
    if (!lg) return withCors(req, NextResponse.json({ league: null }, { headers: { "Cache-Control": "no-store" } }));
    const now = Date.now();
    const fas = loadFreeAgents(db, lg.id).filter((r) => now - Date.parse(r.capturedAt) < FA_MAX_AGE_MS);
    return withCors(req, NextResponse.json({
      league: { id: lg.id, name: lg.name },
      rosterSyncedAt: lastYahooSync(db, lg.id, lg.userSlot),
      freeAgents: fas.length,
      freeAgentsAt: fas.map((r) => r.capturedAt).sort().pop() ?? null,
      fetchFreeAgentPages: lg.settings.fetchFreeAgentPages,
      now: new Date(now).toISOString(),
    }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
