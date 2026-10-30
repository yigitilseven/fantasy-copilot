import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { refreshNews } from "@/server/news";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Runs a news/injury update now (single-flight; waits for it) and returns the summary. A failing source never yields a 5xx. */
export async function POST(req: Request) {
  try {
    const summary = await refreshNews(getDb());
    if (!summary) return withCors(req, NextResponse.json({ error: "News update failed", code: "NEWS_UPDATE_FAILED" }, { status: 502 }));
    return withCors(req, NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
