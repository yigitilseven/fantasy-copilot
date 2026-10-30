import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getLatestActiveDraft } from "@/db/repository";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Lightweight lookup for the Yahoo userscript: the draft the app is currently using. */
export async function GET(req: Request) {
  try {
    const d = getLatestActiveDraft(getDb());
    if (!d) return withCors(req, NextResponse.json({ error: "No active draft — open http://localhost:3000/draft first", code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json({ id: d.id, teams: d.teams, rounds: d.rounds, userSlot: d.userSlot, currentPick: d.currentPick, status: d.status }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
