import { NextResponse } from "next/server";
import { isYahooError } from "@/integrations/yahoo/errors";
import { errorResponse } from "../_lib";

/** Yahoo failures are 502s with a machine-readable code; the draft is never touched, manual mode keeps working. */
export function yahooErrorResponse(e: unknown): NextResponse {
  if (isYahooError(e)) return NextResponse.json({ error: e.message, code: e.code, manualModeAvailable: true }, { status: 502 });
  return errorResponse(e);
}
