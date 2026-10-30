import { NextResponse } from "next/server";
import { vapidFromEnv } from "@/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const v = vapidFromEnv();
  if (!v) return NextResponse.json({ error: "Push is not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing)", code: "PUSH_NOT_CONFIGURED" }, { status: 503 });
  return NextResponse.json({ publicKey: v.publicKey }, { headers: { "Cache-Control": "no-store" } });
}
