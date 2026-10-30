import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provider fetches are held open until the test releases them, so "does not block the response" is observable.
const gate: { release: () => void; promise: Promise<void>; calls: number } = { release: () => {}, promise: Promise.resolve(), calls: 0 };
vi.mock("@/integrations/news/fetch", () => ({
  NEWS_CACHE_DIR: "unused",
  fetchProvider: async () => {
    gate.calls++;
    await gate.promise;
    throw new Error("HTTP 500");
  },
}));

import { createDb } from "@/db/client";
import { POST as draftPost } from "@/app/api/draft/route";
import { isNewsRefreshing, kickPredraftNewsRefresh } from "@/server/news";
import { newsSourceStatus } from "@/db/schema";
import { NEWS_PREDRAFT_MAX_AGE_MS } from "@/integrations/news/update";

const post = (body: unknown = {}) => draftPost(new Request("http://localhost/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const tick = () => new Promise((r) => setTimeout(r, 20));

let db: ReturnType<typeof createDb>;
beforeEach(() => {
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  gate.calls = 0;
  gate.promise = new Promise<void>((r) => (gate.release = r));
  vi.stubEnv("NEWS_PREDRAFT_REFRESH", "1");
});
afterEach(async () => {
  gate.release();
  while (isNewsRefreshing()) await tick();
  vi.unstubAllEnvs();
});

const markFresh = (ageMs: number) => {
  const at = new Date(Date.now() - ageMs).toISOString();
  db.insert(newsSourceStatus).values({ source: "espn-injuries", kind: "injuries", lastAttemptAt: at, lastSuccessAt: at, lastError: null, itemCount: 9 }).run();
};

describe("news refresh when a new draft is created", () => {
  it("POST /api/draft answers 201 immediately while the stale-news refresh runs in the background", async () => {
    const res = await post({ teams: 12, userSlot: 4, rounds: 13 });
    expect(res.status).toBe(201); // returned although every provider fetch is still pending
    expect((await res.json()).currentPick).toBe(1);
    await tick();
    expect(gate.calls).toBeGreaterThan(0);
    expect(isNewsRefreshing()).toBe(true);
    gate.release();
    while (isNewsRefreshing()) await tick();
  });

  it("is single-flight: a second draft while a refresh is running does not start another one", async () => {
    await post();
    await tick();
    const calls = gate.calls;
    await post();
    await tick();
    expect(gate.calls).toBe(calls);
  });

  it("does nothing when the last successful update is younger than 60 min, kicks when older", () => {
    markFresh(10 * 60_000);
    expect(kickPredraftNewsRefresh(db)).toBe(false);
    db.delete(newsSourceStatus).run();
    markFresh(NEWS_PREDRAFT_MAX_AGE_MS + 60_000);
    expect(kickPredraftNewsRefresh(db)).toBe(true);
  });

  it("is off with NEWS_AUTO_REFRESH=0", () => {
    vi.stubEnv("NEWS_AUTO_REFRESH", "0");
    expect(kickPredraftNewsRefresh(db)).toBe(false);
  });
});
