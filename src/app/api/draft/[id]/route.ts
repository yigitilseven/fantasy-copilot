import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { deleteDraft, getDraft } from "@/db/repository";
import { errorResponse, parseId } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const d = getDraft(getDb(), parseId(id));
    return d ? NextResponse.json(d) : NextResponse.json({ error: "Draft not found", code: "DRAFT_NOT_FOUND" }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return deleteDraft(getDb(), parseId(id))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Draft not found", code: "DRAFT_NOT_FOUND" }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
