import { NextResponse } from "next/server";

/**
 * CORS for the Yahoo draft room userscript (extension/). Only https://yahoo.com and https://*.yahoo.com origins are
 * allowed; requests without an Origin header (curl, Playwright, same-origin app) are unaffected.
 * Chrome's Private Network Access preflight (public site -> localhost) is answered with Access-Control-Allow-Private-Network.
 */
const YAHOO_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*yahoo\.com$/i;

export function isAllowedOrigin(origin: string | null): origin is string {
  return !!origin && YAHOO_ORIGIN.test(origin);
}

export function corsHeaders(req: Request, preflight = false): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin)) return { Vary: "Origin" };
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Private-Network": "true",
  };
  if (preflight) {
    h["Access-Control-Allow-Methods"] = "GET, POST, PATCH, PUT, OPTIONS";
    h["Access-Control-Allow-Headers"] = req.headers.get("access-control-request-headers") || "content-type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function withCors(req: Request, res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
  return res;
}

/** OPTIONS handler body. */
export function preflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req, true) });
}
