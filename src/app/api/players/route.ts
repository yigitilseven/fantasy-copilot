import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getAllPlayerRecords } from "@/db/repository";
import { maybeKickNewsRefresh } from "@/server/news";
import { errorResponse } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    maybeKickNewsRefresh();
    return NextResponse.json(getAllPlayerRecords(getDb(), Date.now(), { withComponents: true }));
  } catch (e) {
    return errorResponse(e);
  }
}
