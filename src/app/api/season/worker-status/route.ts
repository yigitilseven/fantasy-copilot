import { NextResponse } from "next/server";
import { preflight, withCors } from "../../_cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const iso = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" && v ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Status of the always-on Yahoo browser worker (VPS), proxied from GET {WORKER_URL}/status:
 * { available: true, needsLogin, lastOkAt, lastRunAt, lastOutcome, runsToday, maxPerDay, nextRunAt, novncUrl }
 * or { available: false, detail }. Timestamps are ISO strings (the worker keeps epoch milliseconds).
 */
export async function GET(req: Request) {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  if (!base) return withCors(req, NextResponse.json({ available: false, detail: "No browser worker configured (WORKER_URL)." }, noStore));
  try {
    const token = process.env.WORKER_TOKEN?.trim();
    const r = await fetch(`${base}/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (r.status === 401) return withCors(req, NextResponse.json({ available: false, detail: "The browser worker rejected the request (WORKER_TOKEN mismatch)." }, noStore));
    if (!r.ok) return withCors(req, NextResponse.json({ available: false, detail: `Browser worker answered HTTP ${r.status}.` }, noStore));
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return withCors(
      req,
      NextResponse.json(
        {
          available: true,
          needsLogin: j.needsLogin === true,
          lastOkAt: iso(j.lastOkAt),
          lastRunAt: iso(j.lastRunAt),
          lastOutcome: str(j.lastOutcome),
          runsToday: int(j.runsToday),
          maxPerDay: int(j.maxPerDay),
          nextRunAt: iso(j.nextRunAt),
          novncUrl: str(j.novncUrl),
        },
        noStore,
      ),
    );
  } catch (e) {
    return withCors(req, NextResponse.json({ available: false, detail: `Browser worker not reachable: ${(e as Error).message}` }, noStore));
  }
}
