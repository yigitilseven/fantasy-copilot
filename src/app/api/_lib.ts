import { NextResponse } from "next/server";
import { z } from "zod";
import { DraftError } from "@/db/repository";
import { SeasonError } from "@/db/season";

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof DraftError) {
    const status = e.code.endsWith("NOT_FOUND") ? 404 : e.code === "INVALID_CONFIG" ? 400 : 409;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  if (e instanceof SeasonError) {
    const status = e.code === "LEAGUE_NOT_FOUND" || e.code === "DRAFT_NOT_FOUND" ? 404 : e.code === "INVALID" ? 400 : 409;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  if (e instanceof z.ZodError)
    return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), code: "VALIDATION_ERROR" }, { status: 400 });
  console.error(e);
  return NextResponse.json({ error: "Internal error", code: "INTERNAL" }, { status: 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new z.ZodError([{ code: "custom", path: [], message: "Invalid JSON body", input: text }]);
  }
}

export function parseId(raw: string): number {
  return z.coerce.number().int().positive().parse(raw);
}
