import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createLeagueFromDraft } from "@/db/season";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const body = z.object({ draftId: z.number().int().positive(), reset: z.boolean().optional() });

/** Same as `pnpm season:init --draft=<id>`: league + teams + rosters from a finished draft (idempotent; reset re-seeds the rosters). */
export async function POST(req: Request) {
  try {
    const b = body.parse(await readJson(req));
    const r = createLeagueFromDraft(getDb(), b.draftId, { reset: b.reset });
    return withCors(req, NextResponse.json({ created: r.created, league: { id: r.league.id, name: r.league.name, teams: r.league.teams } }, { status: r.created ? 201 : 200 }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
