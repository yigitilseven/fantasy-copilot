import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { sendPushToAll } from "@/server/push";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Send test" button: a notification to every subscribed device. */
export async function POST() {
  try {
    const r = await sendPushToAll(getDb(), { title: "Fantasy Copilot", body: "Test notification: push is working.", url: "/today", tag: "test" });
    return NextResponse.json(r, { status: r.configured ? 200 : 503 });
  } catch (e) {
    return errorResponse(e);
  }
}
