import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { createDraft } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { makeRecord } from "./fixtures";
import { GET as activeId, OPTIONS as activeOptions } from "@/app/api/draft/active-id/route";
import { GET as statusGet, OPTIONS as extOptions, POST as extPost } from "@/app/api/draft/[id]/external-picks/route";
import { POST as snapshotPost } from "@/app/api/debug/draftroom-snapshot/route";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const post = (id: number, body: unknown, origin?: string) =>
  extPost(new Request(`http://localhost:3000/api/draft/${id}/external-picks`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), ctx(id));

let draftId: number;
beforeEach(() => {
  const db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  seedFromRecords(db, [makeRecord({ id: "jokic", name: "Nikola Jokic" }), makeRecord({ id: "luka", name: "Luka Doncic" })]);
  draftId = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
});

describe("external-picks route", () => {
  it("answers the preflight for yahoo origins incl. Private Network Access, and not for others", async () => {
    const mk = (origin: string) => new Request("http://localhost:3000/x", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true" } });
    for (const opt of [extOptions, activeOptions]) {
      const ok = opt(mk(YAHOO));
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(YAHOO);
      expect(ok.headers.get("access-control-allow-private-network")).toBe("true");
      expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
      expect(ok.headers.get("access-control-allow-headers")).toBe("content-type");
      for (const bad of ["https://evil.com", "https://yahoo.com.evil.com", "http://basketball.fantasysports.yahoo.com", "https://notyahoo.com"]) {
        expect(opt(mk(bad)).headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    expect(extOptions(mk("https://yahoo.com")).headers.get("access-control-allow-origin")).toBe("https://yahoo.com");
  });

  it("ingests, adds CORS headers, and is idempotent", async () => {
    const body = { source: "yahoo-dom", picks: [{ pick: 1, playerName: "Nikola Jokic", nbaTeam: "DEN", positions: "C", teamName: "Team A" }] };
    const res = await post(draftId, body, YAHOO);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
    expect((await res.json()).ingested).toBe(1);
    expect((await (await post(draftId, body)).json()).ingested).toBe(0);
    const st = await (await statusGet(new Request("http://localhost:3000/x"), ctx(draftId))).json();
    expect(st.draft.currentPick).toBe(2);
    expect(st.status).toMatchObject({ received: 1, totalIngested: 1, highestPick: 1 });
  });

  it("never stalls on an unknown name: 200, placeholder recorded, listed in autoResolved", async () => {
    const res = await post(draftId, { source: "yahoo-dom", picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Nobody Atall" }] }, YAHOO);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ingested: 2, unmapped: null, autoResolved: [{ pick: 2, name: "Nobody Atall", resolution: "placeholder" }] });
  });

  it("validates the body and the draft id", async () => {
    expect((await post(draftId, { source: "other", picks: [] })).status).toBe(400);
    expect((await post(draftId, { source: "yahoo-dom", picks: [{ pick: 0, playerName: "x" }] })).status).toBe(400);
    expect((await post(9999, { source: "yahoo-dom", picks: [] })).status).toBe(404);
  });

  it("active-id returns the active draft", async () => {
    const res = await activeId(new Request("http://localhost:3000/api/draft/active-id", { headers: { origin: YAHOO } }));
    expect(await res.json()).toMatchObject({ id: draftId, teams: 4, currentPick: 1 });
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
  });
});

describe("draftroom-snapshot route", () => {
  const snap = (body: string, headers: Record<string, string> = {}) => snapshotPost(new Request("http://localhost:3000/api/debug/draftroom-snapshot", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  it("rejects oversize bodies and is disabled in production", async () => {
    const big = JSON.stringify({ url: "u", html: "x".repeat(5 * 1024 * 1024 + 10), text: "" });
    expect((await snap(big)).status).toBe(413);
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect((await snap(JSON.stringify({ url: "u", html: "<p/>", text: "" }))).status).toBe(404);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});
