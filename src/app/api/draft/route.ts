import { NextResponse } from "next/server";
import { z } from "zod";
import { leagueConfig } from "@/config/default-league";
import { getDb } from "@/db/client";
import { createDraft, getLatestActiveDraft } from "@/db/repository";
import { kickPredraftNewsRefresh } from "@/server/news";
import { errorResponse, readJson } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  teams: z.number().int().min(2).max(30).default(leagueConfig.teams),
  userSlot: z.number().int().min(1).default(leagueConfig.userSlot),
  rounds: z.number().int().min(1).max(30).default(leagueConfig.rounds),
});

export async function GET() {
  try {
    const d = getLatestActiveDraft(getDb());
    return d ? NextResponse.json(d) : NextResponse.json({ error: "No active draft", code: "DRAFT_NOT_FOUND" }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const b = body.parse(await readJson(req));
    const db = getDb();
    const draft = createDraft(db, b);
    kickPredraftNewsRefresh(db); // fresh injuries/news before the draft starts (background, single-flight, > 60 min old)
    return NextResponse.json(draft, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
