import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getLatestActiveDraft } from "@/db/repository";
import { computeRecommendations } from "@/server/recommendations";
import { preflight, withCors } from "../../../_cors";
import { maybeKickNewsRefresh } from "@/server/news";
import { errorResponse } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Convenience: recommendations for the latest active draft (same body as /api/draft/[id]/recommendations). */
export async function GET(req: Request) {
  try {
    maybeKickNewsRefresh();
    const db = getDb();
    const d = getLatestActiveDraft(db);
    if (!d) return withCors(req, NextResponse.json({ error: "No active draft — open http://localhost:3000/draft first", code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    const raw = Number(new URL(req.url).searchParams.get("limit") ?? 10);
    return withCors(req, NextResponse.json(computeRecommendations(db, d.id, { limit: Number.isFinite(raw) ? raw : 10 }), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
