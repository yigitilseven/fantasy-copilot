import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { autopick } from "@/db/repository";
import { isDomSyncActive } from "@/integrations/yahoo/dom-status";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  untilUserTurn: z.boolean().optional(),
  count: z.number().int().min(1).max(1000).optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = body.parse(await readJson(req));
    const draftId = parseId(id);
    // Bot picks would fight the live Yahoo draft (that's how wrong picks crept in): refuse while Yahoo drives the board.
    if (isDomSyncActive(draftId))
      return NextResponse.json({ error: "Following the Yahoo draft room: bot picks are disabled.", code: "LIVE_SYNC_ACTIVE" }, { status: 409 });
    return NextResponse.json(autopick(getDb(), draftId, b));
  } catch (e) {
    return errorResponse(e);
  }
}
