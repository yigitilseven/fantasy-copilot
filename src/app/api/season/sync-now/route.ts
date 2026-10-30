import { NextResponse } from "next/server";
import { preflight, withCors } from "../../_cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/**
 * Asks the always-on browser worker (VPS) for a full Yahoo sync now: rosters of all teams, matchup, free agents, transactions.
 * { outcome: "started" | "busy" | "skipped" | "unavailable", detail? }. Follow the progress with GET /api/season/sync-status.
 */
export async function POST(req: Request) {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  if (!base) return withCors(req, NextResponse.json({ outcome: "unavailable", detail: "No browser worker configured (WORKER_URL): reload a Yahoo league tab with the userscript to sync." }));
  try {
    const token = process.env.WORKER_TOKEN?.trim();
    const r = await fetch(`${base}/sync`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as { outcome?: string; detail?: string };
    if (r.status === 401) return withCors(req, NextResponse.json({ outcome: "unavailable", detail: "The browser worker rejected the request (WORKER_TOKEN mismatch)." }));
    return withCors(req, NextResponse.json({ outcome: j.outcome ?? (r.status === 202 ? "started" : "error"), detail: j.detail }));
  } catch (e) {
    return withCors(req, NextResponse.json({ outcome: "unavailable", detail: `Browser worker not reachable: ${(e as Error).message}` }));
  }
}
