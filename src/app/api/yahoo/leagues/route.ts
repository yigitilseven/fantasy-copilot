import { NextResponse } from "next/server";
import { YahooDraftProvider } from "@/integrations/yahoo/draft-provider";
import { yahooErrorResponse } from "../_yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/yahoo/leagues            → { leagues }
 *  GET /api/yahoo/leagues?leagueKey= → { config } (num teams, draft type/status, rounds, your slot) */
export async function GET(req: Request) {
  try {
    const provider = new YahooDraftProvider();
    const leagueKey = new URL(req.url).searchParams.get("leagueKey");
    if (leagueKey) return NextResponse.json({ config: await provider.fetchConfig(leagueKey) });
    return NextResponse.json({ leagues: await provider.fetchLeagues() });
  } catch (e) {
    return yahooErrorResponse(e);
  }
}
