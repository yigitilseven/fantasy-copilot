import { NextResponse } from "next/server";
import { hasYahooCredentials } from "@/integrations/yahoo/config";
import { tokenStatus } from "@/integrations/yahoo/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const credentialsConfigured = hasYahooCredentials();
  const t = tokenStatus();
  // Expired access tokens are refreshed automatically, so "authenticated" = credentials + a stored refresh token.
  return NextResponse.json({ authenticated: credentialsConfigured && t.tokensPresent && t.hasRefreshToken, credentialsConfigured, ...t });
}
