import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { removeSubscription } from "@/server/push";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { endpoint } = z.object({ endpoint: z.string().min(1).max(1000) }).parse(await readJson(req));
    return NextResponse.json({ ok: true, removed: removeSubscription(getDb(), endpoint) });
  } catch (e) {
    return errorResponse(e);
  }
}
