import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { SeasonError, getAdds, getLeague, setAddsOverride, updateSettings } from "@/db/season";
import { gameDayOf, weekStartOf } from "@/engine/season/schedule";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

function current(db: ReturnType<typeof getDb>) {
  const lg = getLeague(db);
  if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
  const adds = getAdds(db, lg.id, weekStartOf(gameDayOf(Date.now(), lg.settings.timezone)));
  return { settings: lg.settings, addsDetected: adds.count, addsOverride: adds.override };
}

export async function GET(req: Request) {
  try {
    return withCors(req, NextResponse.json(current(getDb()), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

const putBody = z.object({ settings: z.record(z.string(), z.unknown()).optional(), addsUsed: z.number().int().min(0).max(99).nullable().optional() });

/** Edits league settings (rosterSlots, ilSlots, weeklyAddLimit, lineupLock, playoffWeeks, ...) and/or the manual weekly adds-used override. */
export async function PUT(req: Request) {
  try {
    const body = putBody.parse(await readJson(req));
    const db = getDb();
    const lg = getLeague(db);
    if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
    if (body.settings) updateSettings(db, lg.id, body.settings);
    if (body.addsUsed !== undefined) setAddsOverride(db, lg.id, weekStartOf(gameDayOf(Date.now(), lg.settings.timezone)), body.addsUsed);
    return withCors(req, NextResponse.json(current(db), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
