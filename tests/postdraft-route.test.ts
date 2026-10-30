import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { loadStandings, saveOpponentModel } from "@/db/history";
import { createDraft, getDraft } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { OPTIONS, POST } from "@/app/api/draft/[id]/postdraft/route";
import { GET as modelGet, POST as modelPost } from "@/app/api/history/model/route";
import { makeRecord } from "./fixtures";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const post = (id: number, body: unknown, origin?: string) =>
  POST(new Request(`http://localhost:3000/api/draft/${id}/postdraft`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), ctx(id));

let db: ReturnType<typeof createDb>;
let draftId: number;
beforeEach(() => {
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  seedFromRecords(db, [makeRecord({ id: "jokic", name: "Nikola Jokic" }), makeRecord({ id: "luka", name: "Luka Doncic" })]);
  draftId = createDraft(db, { teams: 2, userSlot: 1, rounds: 1 }).id;
});

describe("postdraft + model routes", () => {
  it("answers CORS preflight for yahoo origins", () => {
    const r = OPTIONS(new Request("http://localhost:3000/x", { method: "OPTIONS", headers: { origin: YAHOO, "access-control-request-method": "POST" } }));
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(YAHOO);
  });
  it("stores standings, teams and board picks (completing the draft) with CORS headers", async () => {
    const res = await post(draftId, {
      standings: [{ view: "avg-2025-26", rows: [{ rank: 1, teamName: "A", total: 10 }, { rank: 2, teamName: "B", total: 9 }] }],
      board: { teams: [{ slot: 1, name: "A", isUser: true }, { slot: 2, name: "B" }], picks: [{ pick: 1, playerName: "Nikola Jokic", teamName: "A" }, { pick: 2, playerName: "Luka Doncic", teamName: "B" }] },
      roomKey: "1/2", leagueName: "L",
    }, YAHOO);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
    expect(await res.json()).toMatchObject({ standingsViews: ["avg-2025-26"], teams: 2, draftComplete: true });
    expect(loadStandings(db, draftId)).toHaveLength(2);
    expect(getDraft(db, draftId)!.picks).toHaveLength(2);
  });
  it("404 for an unknown draft, 400 for a bad body", async () => {
    expect((await post(999, {})).status).toBe(404);
    expect((await post(draftId, { board: { teams: [], picks: [{ pick: 0, playerName: "x" }] } })).status).toBe(400);
  });
  it("model route: no fit -> cannot enable; refit stores a disabled fit; enabling exposes it as active", async () => {
    const json = (r: Response) => r.json();
    expect((await json(await modelGet())).active).toBeNull();
    const bad = await modelPost(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ enabled: true }) }));
    expect(bad.status).toBe(409);
    expect((await modelPost(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ refit: true }) }))).status).toBe(400); // nothing to fit on
    saveOpponentModel(db, { k: 2.5, autopickShare: 0.1 });
    expect((await json(await modelGet())).active).toBeNull(); // stored but disabled
    const on = await json(await modelPost(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ enabled: true }) })));
    expect(on.active).toEqual({ k: on.stored.k, autopickShare: on.stored.autopickShare });
  });
});
