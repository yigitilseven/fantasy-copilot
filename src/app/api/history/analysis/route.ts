import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { runHistoryAnalysis } from "@/server/history-analysis";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reach/fall, runs, autopick, per-manager stats and survival calibration over the clean yahoo-live drafts (?ids=6,7&sims=25000). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ids = url.searchParams.get("ids")?.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const sims = Number(url.searchParams.get("sims")) || undefined;
    return NextResponse.json(runHistoryAnalysis(getDb(), { ids: ids?.length ? ids : undefined, simulations: sims && sims <= 100_000 ? sims : undefined }));
  } catch (e) {
    return errorResponse(e);
  }
}
