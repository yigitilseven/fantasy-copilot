import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getDraft } from "@/db/repository";
import { peekCachedRank } from "@/server/recommendations";
import { ingestDomPicks } from "@/integrations/yahoo/dom-ingest";
import { getDomStatus, recordDomStatus } from "@/integrations/yahoo/dom-status";
import { preflight, withCors } from "../../../_cors";
import { errorResponse, parseId, readJson } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  source: z.literal("yahoo-dom"),
  picks: z
    .array(
      z.object({
        pick: z.number().int().min(1).max(1000),
        playerName: z.string().trim().min(1).max(120),
        nbaTeam: z.string().max(10).optional(),
        positions: z.string().max(40).optional(),
        teamName: z.string().max(120).optional(),
        yahooId: z.string().regex(/^\d{1,12}$/).optional(),
        via: z.literal("header").optional(),
      }),
    )
    .max(1000),
  /** Optional userscript report: is Yahoo's Picks feed in the DOM, and is the tab visible. */
  panel: z.enum(["picks", "hidden", "n/a"]).optional(),
  pageVisible: z.boolean().optional(),
  /** Yahoo draft room key ("<leagueId>/<team>") and league name, stored in draft_meta. */
  roomKey: z.string().max(60).optional(),
  leagueName: z.string().max(120).optional(),
});

export function OPTIONS(req: Request) {
  return preflight(req);
}

/**
 * Read-only mirror of the Yahoo draft room (the userscript only reads the page; nothing is ever drafted on Yahoo).
 * 200 { ingested, draft, mismatches, stoppedReason, ... }; 409 { code: "UNMAPPED_PLAYER", name, ... } when a name at the
 * next pick matches no (or several) local players — earlier picks in the same payload are still ingested, the draft stays
 * consistent, and the app offers a manual fix. 409 PLAYER_ALREADY_DRAFTED when Yahoo's pick is a player drafted elsewhere locally.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = body.parse(await readJson(req));
    const draftId = parseId(id);
    const db = getDb();
    const r = ingestDomPicks({ db, draftId, picks: b.picks, history: { peek: (d, p, pl) => peekCachedRank(db, d, p, pl), roomKey: b.roomKey, leagueName: b.leagueName } });
    recordDomStatus(draftId, r, Date.now(), { panel: b.panel, pageVisible: b.pageVisible });
    if (r.unmapped) {
      const u = r.unmapped;
      return withCors(
        req,
        NextResponse.json(
          { error: `${u.reason === "ambiguous" ? "Ambiguous" : "Unknown"} player "${u.name}" at pick ${u.pick}; ingestion stopped before it. Fix in app.`, code: "UNMAPPED_PLAYER", name: u.name, pick: u.pick, reason: u.reason, manualModeAvailable: true, ...r },
          { status: 409 },
        ),
      );
    }
    if (r.conflict)
      return withCors(
        req,
        NextResponse.json(
          { error: `${r.conflict.name} (Yahoo pick ${r.conflict.pick}) is already drafted at local pick ${r.conflict.alreadyAtPick}.`, code: "PLAYER_ALREADY_DRAFTED", name: r.conflict.name, pick: r.conflict.pick, ...r },
          { status: 409 },
        ),
      );
    return withCors(req, NextResponse.json(r));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}

/** Draft + last delivery status; the app polls this while "Browser sync" is on. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const draftId = parseId((await ctx.params).id);
    const draft = getDraft(getDb(), draftId);
    if (!draft) return withCors(req, NextResponse.json({ error: `Draft ${draftId} not found`, code: "DRAFT_NOT_FOUND" }, { status: 404 }));
    return withCors(req, NextResponse.json({ draft, status: getDomStatus(draftId) }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
