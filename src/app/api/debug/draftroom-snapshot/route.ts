import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { preflight, withCors } from "../../_cors";
import { errorResponse } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const body = z.object({ url: z.string().max(2000), html: z.string(), text: z.string().default(""), label: z.string().regex(/^[a-z-]{1,24}$/).optional(), auto: z.boolean().optional() });

/** Automatic parser-calibration samples (season-<kind>): at most one per label per 6 h, whatever the browser's own bookkeeping says. */
const AUTO_EVERY_MS = 6 * 3_600_000;

const disabled = (req: Request) => withCors(req, NextResponse.json({ error: "Not available in production", code: "NOT_FOUND" }, { status: 404 }));

export function OPTIONS(req: Request) {
  return process.env.NODE_ENV === "production" ? disabled(req) : preflight(req);
}

/**
 * Dev-only: stores a snapshot of the Yahoo draft room page (outerHTML + innerText) sent by the userscript's
 * "Send snapshot" button as data/cache/draftroom-<ts>.html (+ .txt), so the parser's selectors can be calibrated.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return disabled(req);
  try {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return withCors(req, NextResponse.json({ error: "Snapshot larger than 5MB", code: "TOO_LARGE" }, { status: 413 }));
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_BYTES) return withCors(req, NextResponse.json({ error: "Snapshot larger than 5MB", code: "TOO_LARGE" }, { status: 413 }));
    let parsed: unknown = {};
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new z.ZodError([{ code: "custom", path: [], message: "Invalid JSON body", input: raw.slice(0, 50) }]);
    }
    const b = body.parse(parsed);
    const dir = path.resolve(process.cwd(), "data", "cache");
    fs.mkdirSync(dir, { recursive: true });
    if (b.auto && b.label) {
      const recent = fs.readdirSync(dir).some((f) => f.startsWith(`${b.label}-`) && f.endsWith(".html") && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < AUTO_EVERY_MS);
      if (recent) return withCors(req, NextResponse.json({ skipped: true, reason: "a sample of this kind was saved in the last 6 hours" }, { status: 200 }));
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // two saves in the same millisecond must not overwrite each other
    let base = path.join(dir, `${b.label ?? "draftroom"}-${ts}`);
    for (let n = 2; fs.existsSync(`${base}.html`); n++) base = path.join(dir, `${b.label ?? "draftroom"}-${ts}-${n}`);
    fs.writeFileSync(`${base}.html`, `<!-- url: ${b.url.replace(/--+/g, "-")} -->\n${b.html}`);
    fs.writeFileSync(`${base}.txt`, `url: ${b.url}\n\n${b.text}`);
    return withCors(req, NextResponse.json({ saved: `${base}.html`, textFile: `${base}.txt`, bytes: Buffer.byteLength(raw) }, { status: 201 }));
  } catch (e) {
    return withCors(req, errorResponse(e));
  }
}
