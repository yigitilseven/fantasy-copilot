import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { recordPick } from "@/db/repository";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  playerId: z.string().min(1),
  source: z.enum(["manual", "yahoo", "simulation"]).default("manual"),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = body.parse(await readJson(req));
    return NextResponse.json(recordPick(getDb(), parseId(id), b.playerId, b.source));
  } catch (e) {
    return errorResponse(e);
  }
}
