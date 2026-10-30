import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { getLeague } from "@/db/season";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + DB check for the Docker health check / uptime monitors. 200 {ok:true} when SQLite answers, 503 otherwise. No secrets. */
export async function GET() {
  try {
    const db = getDb();
    db.run(sql`select 1`);
    return NextResponse.json({ ok: true, league: !!getLeague(db), tz: process.env.TZ ?? null, now: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "db error" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
