import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = (f: string) => fs.readFileSync(path.resolve(__dirname, "fixtures-news", f), "utf8");
const BODY: Record<string, string> = {
  "espn-injuries": fx("espn-injuries.json"),
  "yahoo-rss": fx("yahoo-rss.xml"),
  "rotowire-rss": fx("rotowire-rss.xml"),
};
vi.mock("@/integrations/news/fetch", () => ({
  NEWS_CACHE_DIR: "unused",
  fetchProvider: async (p: { id: string }) => {
    if (!(p.id in BODY)) throw new Error("HTTP 500");
    return { text: BODY[p.id], fetchedAt: new Date().toISOString() };
  },
}));

import { createDb } from "@/db/client";
import { createDraft } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { GET as statusGet, OPTIONS as statusOptions } from "@/app/api/news/status/route";
import { POST as refreshPost } from "@/app/api/news/refresh/route";
import { GET as recGet } from "@/app/api/draft/[id]/recommendations/route";
import { computeRecommendations, resetRecommendationCaches } from "@/server/recommendations";
import { makeRecord } from "./fixtures";

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
let draftId: number;
beforeEach(() => {
  resetRecommendationCaches();
  const db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  const names = ["Jimmy Butler", "Aaron Wiggins", "Brandin Podziemski", "Stephen Curry"];
  seedFromRecords(db, names.map((n, i) => makeRecord({ id: n.split(" ")[1].toLowerCase(), name: n, market: { yahooAdp: i + 1, rank: i + 1 } })));
  draftId = createDraft(db, { teams: 2, userSlot: 1, rounds: 13 }).id;
});

describe("news routes", () => {
  it("status: never updated -> stale, no sources; preflight allows yahoo origins", async () => {
    const r = await statusGet(new Request("http://localhost/api/news/status", { headers: { origin: "https://basketball.fantasysports.yahoo.com" } }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j).toMatchObject({ lastSuccessAt: null, stale: true, refreshing: false, sources: [] });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://basketball.fantasysports.yahoo.com");
    expect(statusOptions(new Request("http://localhost/x", { method: "OPTIONS", headers: { origin: "https://x.yahoo.com" } })).status).toBe(204);
  });

  it("refresh: runs the update, a failing source does not fail the request, status reflects per-source ok/error", async () => {
    const r = await refreshPost(new Request("http://localhost/api/news/refresh", { method: "POST" }));
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.sources.find((x: { id: string }) => x.id === "espn-injuries").ok).toBe(true);
    expect(s.sources.find((x: { id: string }) => x.id === "cbs-injuries")).toMatchObject({ ok: false, error: "HTTP 500" });
    const st = await (await statusGet(new Request("http://localhost/api/news/status"))).json();
    expect(st.stale).toBe(false);
    expect(st.lastSuccessAt).toBeTruthy();
    expect(st.sources.find((x: { id: string }) => x.id === "cbs-injuries")).toMatchObject({ ok: false, lastError: "HTTP 500" });
    expect(st.lastSummary).toBeTruthy();
  });

  it("refresh is single-flight", async () => {
    const [a, b] = await Promise.all([refreshPost(new Request("http://localhost/r", { method: "POST" })), refreshPost(new Request("http://localhost/r", { method: "POST" }))]);
    expect((await a.json()).startedAt).toBe((await b.json()).startedAt);
  });

  it("recommendations carry status/injuryNote and reflect a refresh immediately (cache invalidated)", async () => {
    const before = computeRecommendations(createDbFromGlobal(), draftId)!;
    expect(before.top.find((t) => t.playerId === "butler")).toMatchObject({ status: "healthy", injuryNote: null });
    await refreshPost(new Request("http://localhost/r", { method: "POST" }));
    const res = await recGet(new Request("http://localhost/api/draft/1/recommendations"), ctx(draftId));
    const j = await res.json();
    const butler = j.top.find((t: { playerId: string }) => t.playerId === "butler");
    expect(butler.status).toBe("out");
    expect(butler.injuryNote).toMatch(/^Out — est\. return Jan 2 \(ESPN, Oct 2\)/);
    // ~35 games missed are priced into value (not a blanket AVOID): his score drops by roughly that share.
    const butlerBefore = before.top.find((t) => t.playerId === "butler")!;
    expect(butler.score).toBeLessThan(butlerBefore.score * 0.75);
    expect(j.board.find((b: { playerId: string }) => b.playerId === "butler").status).toBe("out");
    expect(j.top.find((t: { playerId: string }) => t.playerId === "curry").status).toBe("day-to-day");
  });
});

function createDbFromGlobal() {
  return (globalThis as unknown as { __fantasyDb: ReturnType<typeof createDb> }).__fantasyDb;
}
