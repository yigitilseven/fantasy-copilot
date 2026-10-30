import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getLeague, getTeams, getTransactions, SeasonError } from "@/db/season";
import { ingestTransactions, transactionsBody } from "@/server/season-ingest";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { preflight, withCors } from "../../_cors";
import { errorResponse, readJson } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(req: Request) {
  return preflight(req);
}

/** The userscript posts the adds/drops it read on Yahoo's transactions page; new ones are applied to the rosters. */
export async function POST(req: Request) {
  try {
    const body = transactionsBody.parse(await readJson(req));
    const db = getDb();
    const r = ingestTransactions(db, body);
    resetSeasonPlayerCache(db);
    return withCors(req, NextResponse.json(r, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

export interface LeagueTransaction {
  date: string | null;
  time: string | null;
  team: string | null;
  teamSlot: number | null;
  isUser: boolean;
  type: "add" | "drop" | "trade";
  player: string;
  playerId: string | null;
}

const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

/** Recent league transactions, newest first, one entry per player action: { count, transactions }. */
export async function GET(req: Request) {
  try {
    const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const db = getDb();
    const lg = getLeague(db);
    if (!lg) throw new SeasonError("LEAGUE_NOT_FOUND", "No season league yet");
    const teams = new Map(getTeams(db, lg.id).map((t) => [t.slot, t]));
    const out: LeagueTransaction[] = [];
    for (const t of getTransactions(db, lg.id)) {
      for (const a of t.actions) {
        const team = a.teamSlot != null ? teams.get(a.teamSlot) : undefined;
        out.push({ date: t.occurredOn, time: t.occurredTime, team: team?.name ?? a.teamName ?? null, teamSlot: a.teamSlot, isUser: !!team?.isUser, type: a.action, player: a.name, playerId: a.playerId });
      }
    }
    const limit = q.limit ?? 50;
    return withCors(req, NextResponse.json({ count: out.length, transactions: out.slice(0, limit) }, { headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
