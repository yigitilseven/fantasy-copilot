import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ackInjuryEvents, pendingInjuryEvents } from "@/server/injury-events";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending injury events (status changes of players on your roster, queued after each news refresh). Used by the scheduler container. */
export async function GET() {
  try {
    return NextResponse.json({ events: pendingInjuryEvents(getDb()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { ids: string[] } removes handled events. */
export async function POST(req: Request) {
  try {
    const { ids } = z.object({ ids: z.array(z.string()).max(200) }).parse(await readJson(req));
    return NextResponse.json({ removed: ackInjuryEvents(getDb(), ids) });
  } catch (e) {
    return errorResponse(e);
  }
}
