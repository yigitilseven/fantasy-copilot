import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { updateDraftStrategy } from "@/db/repository";
import { STRATEGY_PRESETS } from "@/engine/recommendation/strategy";
import { CATEGORIES } from "@/types";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const emphasis = z.object(Object.fromEntries(CATEGORIES.map((c) => [c, z.number().min(0).max(3).optional()]))).strict();
const body = z
  .object({
    preset: z.enum(STRATEGY_PRESETS as [string, ...string[]]).optional(),
    riskTolerance: z.number().min(0).max(1).optional(),
    categoryEmphasis: emphasis.optional(),
    /** Yahoo share (0..1) of the Yahoo 2026-27 / real 2025-26 projection blend; selects the "fixed" mix unless projectionMode is given. */
    projectionWeight: z.number().min(0).max(1).optional(),
    /** "auto" (default) = per-player rate/volume weights; "fixed" = projectionWeight for everybody. */
    projectionMode: z.enum(["auto", "fixed"]).optional(),
    /** Consistency-penalty lambda: > 0 selects the "always" mode, 0 selects "never". */
    robustness: z.number().min(0).max(1).optional(),
    /** "auto" (default) = round-aware, "always" = lambda everywhere, "never" = off. */
    robustnessMode: z.enum(["auto", "always", "never"]).optional(),
    /** Standings objective: "h2h" (default) | "robust" | "max-total" | "classic". */
    objective: z.enum(["h2h", "robust", "max-total", "classic"]).optional(),
  })
  .strict();

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Partial strategy update -> the full DraftState (with `strategy`). A non-custom preset resets the emphasis to the preset's. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const draftId = parseId((await ctx.params).id);
    const b = body.parse(await readJson(req));
    return withCors(req, NextResponse.json(updateDraftStrategy(getDb(), draftId, b as Parameters<typeof updateDraftStrategy>[2])));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
