import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { saveSubscription } from "@/server/push";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const subscriptionSchema = z.object({ endpoint: z.url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(5).max(100) }) });

/** Body: the browser's PushSubscription JSON. Same endpoint again = update (no duplicates). */
export async function POST(req: Request) {
  try {
    const sub = subscriptionSchema.parse(await readJson(req));
    const result = saveSubscription(getDb(), sub, req.headers.get("user-agent")?.slice(0, 300) ?? null);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return errorResponse(e);
  }
}
