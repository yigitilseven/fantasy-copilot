import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { sendPushToAll } from "@/server/push";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ title: z.string().max(200).optional(), body: z.string().min(1).max(2000), url: z.string().max(500).optional(), tag: z.string().max(64).optional() });

/** Used by the scheduler / browser-worker containers (internal network) to push a notification to every device. */
export async function POST(req: Request) {
  try {
    const r = await sendPushToAll(getDb(), body.parse(await readJson(req)));
    return NextResponse.json(r, { status: r.configured ? 200 : 503 });
  } catch (e) {
    return errorResponse(e);
  }
}
