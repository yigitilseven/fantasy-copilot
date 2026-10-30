import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { ensureDraftMeta, listDraftSummaries } from "@/db/history";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All drafts with kind, user slot and the user's standings rank per view. Fills draft_meta for drafts that have none yet. */
export async function GET() {
  try {
    const db = getDb();
    for (const s of listDraftSummaries(db)) ensureDraftMeta(db, s.id);
    return NextResponse.json({ drafts: listDraftSummaries(db) });
  } catch (e) {
    return errorResponse(e);
  }
}
