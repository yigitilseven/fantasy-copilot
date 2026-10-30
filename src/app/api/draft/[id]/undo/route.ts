import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { undoLastPick, undoToPick } from "@/db/repository";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ toPick: z.number().int().min(1).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = body.parse(await readJson(req));
    const draftId = parseId(id);
    return NextResponse.json(b.toPick === undefined ? undoLastPick(getDb(), draftId) : undoToPick(getDb(), draftId, b.toPick));
  } catch (e) {
    return errorResponse(e);
  }
}
