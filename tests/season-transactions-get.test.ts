import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/season-txn-get-test-cache`);
vi.mock("@/integrations/projections/stats-lookup", async (orig) => ({ ...(await orig<typeof import("@/integrations/projections/stats-lookup")>()), defaultStatsCacheDir: () => TMP }));

import { createDb, type Db } from "@/db/client";
import { insertTransaction } from "@/db/season";
import { GET } from "@/app/api/season/transactions/route";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { seedSeasonLeague } from "./season-fixtures";

let db: Db;
let leagueId: number;
beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  resetSeasonPlayerCache(db);
  ({ leagueId } = seedSeasonLeague(db));
});
const get = (url: string) => new Request(`http://localhost${url}`);

describe("GET /api/season/transactions", () => {
  it("404 without a league", async () => {
    (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = createDb(":memory:");
    expect((await GET(get("/api/season/transactions"))).status).toBe(404);
  });

  it("returns one entry per action, newest first, honoring ?limit=", async () => {
    insertTransaction(db, leagueId, { key: "a", kind: "add/drop", occurredOn: "2026-10-20", occurredTime: null, actions: [{ action: "add", yahooId: "1", name: "Old Add", playerId: null, teamSlot: 13 }] }, "2026-10-20T00:00:00Z");
    insertTransaction(db, leagueId, { key: "b", kind: "add/drop", occurredOn: "2026-10-22", occurredTime: "10:00", actions: [{ action: "add", yahooId: "2", name: "New Add", playerId: null, teamSlot: 5 }, { action: "drop", yahooId: "3", name: "New Drop", playerId: null, teamSlot: 5 }] }, "2026-10-22T00:00:00Z");
    const r = await GET(get("/api/season/transactions"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.count).toBe(3);
    expect(j.transactions.map((t: { player: string }) => t.player)).toEqual(["New Add", "New Drop", "Old Add"]);
    expect(j.transactions[0]).toMatchObject({ date: "2026-10-22", type: "add", isUser: false });
    expect(typeof j.transactions[0].team).toBe("string");
    expect(j.transactions[2].isUser).toBe(true);
    const l = await (await GET(get("/api/season/transactions?limit=1"))).json();
    expect(l.count).toBe(3);
    expect(l.transactions).toHaveLength(1);
    expect((await GET(get("/api/season/transactions?limit=0"))).status).toBe(400);
  });
});
