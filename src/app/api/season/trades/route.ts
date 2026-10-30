import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { SeasonError } from "@/db/season";
import { checkTrade, computeTradeIdeas } from "@/server/season-trades";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(20).optional() });

/** Trade offers worth making: both sides gain, best for you first. */
export async function GET(req: Request) {
  try {
    const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const r = computeTradeIdeas(getDb(), { date: q.date, limit: q.limit });
    if (!r) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

const team = z.union([z.string(), z.number().int()]).optional();
const checkBody = z.object({
  a: z.object({ team, gives: z.array(z.string().min(2)).min(1).max(4) }).optional(),
  b: z.object({ team, gives: z.array(z.string().min(2)).min(1).max(4) }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Checks one trade by player names: { a?: { team?, gives }, b: { team?, gives } } (a = your team unless named). */
export async function POST(req: Request) {
  try {
    const body = checkBody.parse(await readJson(req));
    return withCors(req, NextResponse.json(checkTrade(getDb(), body, { date: body.date }), { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
