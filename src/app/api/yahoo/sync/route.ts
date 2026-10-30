import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { YahooDraftProvider } from "@/integrations/yahoo/draft-provider";
import { syncYahooDraft } from "@/integrations/yahoo/sync";
import { readJson } from "../../_lib";
import { yahooErrorResponse } from "../_yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ draftId: z.number().int().positive(), leagueKey: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const b = body.parse(await readJson(req));
    const provider = new YahooDraftProvider();
    const r = await syncYahooDraft({ db: getDb(), draftId: b.draftId, leagueKey: b.leagueKey, fetcher: provider });
    if (r.unmapped.length) {
      // Names let the UI offer a manual "this is player X" fix; best effort, never fails the response.
      const unmapped = await Promise.all(r.unmapped.map(async (u) => ({ ...u, name: await provider.fetchPlayerName(u.yahooPlayerKey) })));
      return NextResponse.json(
        { error: `${r.unmapped.length} Yahoo pick(s) could not be mapped to a known player; ingestion stopped before pick ${r.unmapped[0].pick}. Enter it manually.`, code: "UNMAPPED_PLAYER", manualModeAvailable: true, ...r, unmapped },
        { status: 502 },
      );
    }
    return NextResponse.json(r);
  } catch (e) {
    return yahooErrorResponse(e);
  }
}
