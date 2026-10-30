import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { applyPostdraft } from "@/integrations/yahoo/postdraft";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = z.number().finite().optional();
const pick = z.object({
  pick: z.number().int().min(1).max(1000),
  playerName: z.string().trim().min(1).max(120),
  nbaTeam: z.string().max(10).optional(),
  positions: z.string().max(40).optional(),
  teamName: z.string().max(120).optional(),
  yahooId: z.string().regex(/^\d{1,12}$/).optional(),
});

const body = z.object({
  standings: z
    .array(
      z.object({
        view: z.string().max(40),
        rows: z
          .array(z.object({ rank: z.number().finite(), teamName: z.string().trim().min(1).max(120), fg: num, ft: num, threePm: num, pts: num, reb: num, ast: num, stl: num, blk: num, tov: num, total: num }))
          .max(40),
      }),
    )
    .max(6)
    .optional(),
  board: z
    .object({
      teams: z.array(z.object({ slot: z.number().int().min(1).max(40), name: z.string().trim().min(1).max(120), isUser: z.boolean().optional() })).max(40),
      picks: z.array(pick).max(1000),
    })
    .optional(),
  results: z.object({ picks: z.array(pick).max(1000) }).optional(),
  roomKey: z.string().max(60).optional(),
  leagueName: z.string().max(120).optional(),
});

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** Post-draft capture from the Yahoo draft room (Board / Standings / Results tabs after "Draft Complete"). Idempotent. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const draftId = parseId((await ctx.params).id);
    const b = body.parse(await readJson(req));
    return withCors(req, NextResponse.json(applyPostdraft(getDb(), draftId, b)));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
