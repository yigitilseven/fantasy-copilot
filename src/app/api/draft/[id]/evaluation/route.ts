import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { DEFAULT_PROJECTION_WEIGHT } from "@/engine/projection/blend";
import { projectionModeOf, projectionWeightOf } from "@/engine/recommendation/strategy";
import { getDraft } from "@/db/repository";
import { computeEvaluation, computeOutlook, EVAL_VIEWS, type EvalView } from "@/server/evaluation";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const bad = (req: Request, error: string) => withCors(req, NextResponse.json({ error, code: "INVALID_CONFIG" }, { status: 400 }));

/**
 * Yahoo-style roto standings of the draft's rosters.
 *   ?view=proj|total|avg|blend|auto   (default blend)   proj = Yahoo 2026-27 totals, total = 2025-26 totals, avg = 2025-26 per-game sums, auto = per-player rate/volume blend
 *   ?w=0.6                       Yahoo weight of the blend (default: the draft's strategy.projectionWeight)
 *   ?view=outlook                your rank under every view + the blended rank for w = 0, 0.2 ... 1
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const draftId = parseId((await ctx.params).id);
    const q = new URL(req.url).searchParams;
    const view = q.get("view") ?? "blend";
    if (view !== "outlook" && !(EVAL_VIEWS as readonly string[]).includes(view)) return bad(req, `view must be one of ${[...EVAL_VIEWS, "outlook"].join(", ")}`);
    let weight: number | undefined;
    if (q.get("w") !== null) {
      weight = Number(q.get("w"));
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) return bad(req, "w must be a number between 0 and 1");
    }
    const db = getDb();
    const draft = getDraft(db, draftId);
    if (!draft) return withCors(req, NextResponse.json({ error: `Draft ${draftId} not found`, code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    weight ??= draft.strategy ? projectionWeightOf(draft.strategy) : DEFAULT_PROJECTION_WEIGHT;
    const body = view === "outlook" ? computeOutlook(db, draftId, { weight, mode: projectionModeOf(draft.strategy) }) : computeEvaluation(db, draftId, { view: view as EvalView, weight });
    return withCors(req, NextResponse.json(body, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
