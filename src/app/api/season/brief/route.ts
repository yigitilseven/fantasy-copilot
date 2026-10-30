import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getOrCreateBrief, renderBriefText } from "@/server/season-brief";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Today's stored brief (generated once per game day); ?refresh=1 regenerates, ?format=text returns plain text. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const r = getOrCreateBrief(getDb(), { force: url.searchParams.get("refresh") === "1" });
    if (!r) return withCors(req, NextResponse.json({ error: "No season league yet. Run `pnpm season:init --draft=<id>`.", code: "LEAGUE_NOT_FOUND" }, { status: 404 }));
    if (url.searchParams.get("format") === "text") return withCors(req, new NextResponse(renderBriefText(r.brief), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }));
    return withCors(req, NextResponse.json({ ...r.brief, created: r.created }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
