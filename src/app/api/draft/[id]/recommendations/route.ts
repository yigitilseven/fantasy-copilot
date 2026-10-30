import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { maybeKickNewsRefresh } from "@/server/news";
import { computeRecommendations } from "@/server/recommendations";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Server-side recommendations for the Yahoo userscript overlay; same engine, strategy and sim seed as the app. ?limit=10 (1-100). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    maybeKickNewsRefresh();
    const draftId = parseId((await ctx.params).id);
    const raw = Number(new URL(req.url).searchParams.get("limit") ?? 10);
    const r = computeRecommendations(getDb(), draftId, { limit: Number.isFinite(raw) ? raw : 10 });
    if (!r) return withCors(req, NextResponse.json({ error: `Draft ${draftId} not found`, code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
