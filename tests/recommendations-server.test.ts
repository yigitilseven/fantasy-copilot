import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { createDraft, recordPick, undoLastPick, updateDraftStrategy } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { computeRecommendations, recommendationCacheStats, resetRecommendationCaches } from "@/server/recommendations";
import { GET as recGet, OPTIONS as recOptions } from "@/app/api/draft/[id]/recommendations/route";
import { GET as activeRecGet } from "@/app/api/draft/active/recommendations/route";
import { OPTIONS as stratOptions, PATCH as stratPatch } from "@/app/api/draft/[id]/strategy/route";
import { makeRecord } from "./fixtures";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

function universe(n = 220) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = 1 - i / n;
    const k = i % 5;
    out.push(
      makeRecord({
        id: `u${i}`, name: `Player ${i}`,
        positions: [(["PG", "SG", "SF", "PF", "C"] as const)[k]],
        projection: {
          pts: 8 + 18 * q + (k % 2), threePm: 0.5 + 2 * q * (k < 2 ? 1.3 : 0.4), reb: 3 + 8 * q * (k > 2 ? 1.4 : 0.5),
          ast: 1.5 + 6 * q * (k < 2 ? 1.4 : 0.4), stl: 0.5 + q, blk: 0.2 + 1.2 * q * (k > 2 ? 1.5 : 0.3), tov: 1 + 2 * q,
          // a block of poor FT shooters / great FG% bigs
          ...(i % 7 === 0 ? { ftm: 1.5, fta: 4, fgm: 7, fga: 11 } : {}),
        },
        market: { yahooAdp: i + 1, rank: i + 1 },
      }),
    );
  }
  return out;
}

let db: Db;
let draftId: number;
beforeEach(() => {
  resetRecommendationCaches();
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  seedFromRecords(db, universe());
  draftId = createDraft(db, { teams: 14, userSlot: 5, rounds: 13 }).id;
});

describe("computeRecommendations", () => {
  it("returns the documented contract", () => {
    const r = computeRecommendations(db, draftId, { limit: 10 })!;
    expect(Object.keys(r).sort()).toEqual(
      ["board", "currentPick", "draftId", "generatedAt", "needs", "objective", "onClock", "picksUntilUser", "projection", "roster", "simMs", "standings", "status", "strategy", "teams", "top", "totalPicks", "userNextPick", "userSlot"].sort(),
    );
    expect(r).toMatchObject({ draftId, currentPick: 1, totalPicks: 182, status: "active", teams: 14, userSlot: 5, onClock: false, userNextPick: 5, picksUntilUser: 4 });
    expect(r.strategy).toEqual({ preset: "balanced", riskTolerance: 0.3, puntedCategories: [] });
    expect(r.needs).toHaveLength(9);
    expect(r.needs.map((n) => n.weight)).toEqual([...r.needs.map((n) => n.weight)].sort((a, b) => b - a));
    expect(r.roster).toEqual([]);
    expect(r.top).toHaveLength(10);
    expect(r.board).toHaveLength(220);
    expect(r.board[0]).toMatchObject({ rank: 1 });
    expect(r.board[219].rank).toBe(220);
    expect(r.top[0]).toEqual({
      playerId: expect.any(String), name: expect.any(String), nbaTeam: "TST", positions: expect.any(String), adp: expect.any(Number),
      state: expect.stringMatching(/^(DRAFT|TAKE|WAIT|RISKY WAIT|AVOID)$/), score: expect.any(Number), nineCat: expect.any(Number),
      rosterFit: expect.any(Number), survival: expect.any(Number), riskLabel: expect.stringMatching(/^(Low|Medium|High)$/), reason: expect.any(String),
      status: "healthy", injuryNote: null, roto: expect.any(Number), dWinProb: expect.any(Number),
    });
    expect(r.objective).toBe("h2h");
    expect(r.standings).toMatchObject({ kind: "h2h", finishLine: expect.stringMatching(/^Projected finish: Proj #\d+ \u00b7 Total #\d+ \u00b7 Avg #\d+$/), weeklyLine: expect.stringMatching(/^Weekly outlook: wins ~\d\.\d cats/) });
    expect(r.top[0].playerId).toBe(r.board[0].playerId);
    expect(r.top[0].score).toBe(r.board[0].score);
    expect(typeof r.simMs).toBe("number");
    expect(Number.isNaN(Date.parse(r.generatedAt))).toBe(false);
    expect(computeRecommendations(db, 9999)).toBeNull();
  });

  it("on the clock: userNextPick == currentPick, picksUntilUser 0, DRAFT recommended", () => {
    for (let i = 0; i < 4; i++) recordPick(db, draftId, `u${i}`, "yahoo-dom");
    const r = computeRecommendations(db, draftId)!;
    expect(r).toMatchObject({ currentPick: 5, onClock: true, userNextPick: 5, picksUntilUser: 0 });
    expect(r.top.filter((t) => t.state === "DRAFT")).toHaveLength(1);
    expect(r.board).toHaveLength(216);
  });

  it("strategy change alters the ranking and reports punted categories; needs ignore them", () => {
    const base = computeRecommendations(db, draftId, { limit: 50 })!;
    updateDraftStrategy(db, draftId, { preset: "punt-ft" });
    const punt = computeRecommendations(db, draftId, { limit: 50 })!;
    expect(punt.strategy).toEqual({ preset: "punt-ft", riskTolerance: 0.3, puntedCategories: ["FT%"] });
    expect(punt.board.map((b) => b.playerId)).not.toEqual(base.board.map((b) => b.playerId));
    expect(punt.needs.at(-1)).toEqual({ category: "FT%", weight: 0 });
    const poorFt = punt.board.find((b) => b.playerId === "u7")!.rank;
    expect(poorFt).toBeLessThan(base.board.find((b) => b.playerId === "u7")!.rank);
  });

  it("memoizes per draft state and invalidates on a new pick, undo or strategy change", () => {
    computeRecommendations(db, draftId);
    computeRecommendations(db, draftId);
    expect(recommendationCacheStats).toMatchObject({ misses: 1, hits: 1, sims: 1 });
    recordPick(db, draftId, "u0", "yahoo-dom");
    computeRecommendations(db, draftId);
    expect(recommendationCacheStats.misses).toBe(2);
    updateDraftStrategy(db, draftId, { riskTolerance: 0.05 });
    computeRecommendations(db, draftId);
    expect(recommendationCacheStats.misses).toBe(3);
    undoLastPick(db, draftId);
    recordPick(db, draftId, "u1", "yahoo-dom");
    computeRecommendations(db, draftId);
    expect(recommendationCacheStats.misses).toBe(4);
  });

  it("is deterministic across calls and uses the client seed derivation (survival stable)", () => {
    const a = computeRecommendations(db, draftId)!;
    resetRecommendationCaches();
    const b = computeRecommendations(db, draftId)!;
    expect(b.top.map((t) => [t.playerId, t.survival, t.score])).toEqual(a.top.map((t) => [t.playerId, t.survival, t.score]));
  });

  it("completes within 300 ms including the sim for 220 players", () => {
    computeRecommendations(db, draftId); // warm JIT
    resetRecommendationCaches();
    const t0 = performance.now();
    computeRecommendations(db, draftId);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("complete draft: empty top/board, no survival", () => {
    const d2 = createDraft(db, { teams: 2, userSlot: 1, rounds: 1 }).id;
    recordPick(db, d2, "u0");
    recordPick(db, d2, "u1");
    const r = computeRecommendations(db, d2)!;
    expect(r).toMatchObject({ status: "complete", top: [], board: [], userNextPick: null, picksUntilUser: null, simMs: null });
    expect(r.roster).toHaveLength(1);
  });
});

describe("routes", () => {
  it("GET recommendations with CORS, limit, 404; active convenience", async () => {
    const res = await recGet(new Request(`http://localhost:3000/x?limit=3`, { headers: { origin: YAHOO } }), ctx(draftId));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
    expect((await res.json()).top).toHaveLength(3);
    expect((await recGet(new Request("http://localhost:3000/x"), ctx(9999))).status).toBe(404);
    const act = await activeRecGet(new Request("http://localhost:3000/x", { headers: { origin: YAHOO } }));
    expect((await act.json()).draftId).toBe(draftId);
    const pre = recOptions(new Request("http://localhost:3000/x", { method: "OPTIONS", headers: { origin: YAHOO, "access-control-request-private-network": "true" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("PATCH strategy returns the DraftState, validates, and has CORS preflight with PATCH", async () => {
    const patch = (body: unknown) =>
      stratPatch(new Request("http://localhost:3000/x", { method: "PATCH", headers: { "content-type": "application/json", origin: YAHOO }, body: JSON.stringify(body) }), ctx(draftId));
    const res = await patch({ preset: "punt-to", riskTolerance: 0.15 });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
    const d = await res.json();
    expect(d.id).toBe(draftId);
    expect(d.strategy).toMatchObject({ preset: "punt-to", riskTolerance: 0.15 });
    expect(d.strategy.categoryEmphasis.TO).toBe(0);
    expect((await patch({ riskTolerance: 5 })).status).toBe(400);
    expect((await patch({ preset: "nope" })).status).toBe(400);
    const custom = await (await patch({ categoryEmphasis: { BLK: 2 } })).json();
    expect(custom.strategy.preset).toBe("custom");
    const pre = stratOptions(new Request("http://localhost:3000/x", { method: "OPTIONS", headers: { origin: YAHOO } }));
    expect(pre.headers.get("access-control-allow-methods")).toContain("PATCH");
    const missing = await stratPatch(new Request("http://localhost:3000/x", { method: "PATCH", body: "{}" }), ctx(4242));
    expect(missing.status).toBe(404);
  });
});
