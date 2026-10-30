import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { loadClaudeBriefStatus, saveClaudeBrief } from "@/server/claude-brief";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Today's stored Claude analysis ({brief: null} when none yet). */
export async function GET() {
  try {
    return NextResponse.json(loadClaudeBriefStatus(getDb()), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** The scheduler stores the full text it generated (and whether Claude or the plain engine produced it). */
export async function POST(req: Request) {
  try {
    const b = z.object({ text: z.string().min(1).max(20000), usedClaude: z.boolean(), note: z.string().max(300).optional(), kind: z.string().max(40).optional() }).parse(await readJson(req));
    const saved = saveClaudeBrief(getDb(), b);
    if (!saved) return NextResponse.json({ error: "No season league yet", code: "LEAGUE_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ok: true, day: saved.day });
  } catch (e) {
    return errorResponse(e);
  }
}
