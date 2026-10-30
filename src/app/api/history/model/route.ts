import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { activeOpponentModel, loadStoredModel, setOpponentModelEnabled } from "@/db/history";
import { invalidateRecommendationCaches } from "@/server/recommendations";
import { refitAndSave } from "@/server/history-analysis";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stored fit and the parameters the simulator currently uses (null = defaults). */
export async function GET() {
  try {
    const db = getDb();
    return NextResponse.json({ stored: loadStoredModel(db), active: activeOpponentModel(db) ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

const body = z.object({ enabled: z.boolean().optional(), refit: z.boolean().optional() });

/** { refit: true } re-fits on the clean drafts (a few seconds) and stores it; { enabled } switches the fitted model on/off for the simulator. */
export async function POST(req: Request) {
  try {
    const b = body.parse(await readJson(req));
    const db = getDb();
    let fit = null;
    if (b.refit) fit = refitAndSave(db);
    if (b.enabled !== undefined) {
      if (b.enabled && !loadStoredModel(db)) return NextResponse.json({ error: "No fitted model yet; refit first", code: "NO_MODEL" }, { status: 409 });
      setOpponentModelEnabled(db, b.enabled);
    }
    invalidateRecommendationCaches();
    return NextResponse.json({ stored: loadStoredModel(db), active: activeOpponentModel(db) ?? null, fit });
  } catch (e) {
    return errorResponse(e);
  }
}
