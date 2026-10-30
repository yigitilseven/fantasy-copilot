import { beforeEach, describe, expect, it } from "vitest";
import type { PlayerRecord } from "@/types";
import { createDb, type Db } from "@/db/client";
import { createDraft, recordPick, updateDraftStrategy } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { computeValuations } from "@/engine/valuation/value";
import { scorePlayers, type RecommendInput } from "@/engine/recommendation/score";
import { scoreWithRoto } from "@/engine/recommendation/with-roto";
import { rotoReason } from "@/engine/recommendation/explain";
import { applyStrategyPatch, defaultStrategy, valuationOptionsOf } from "@/engine/recommendation/strategy";
import { analyzeRoto } from "@/engine/standings-opt/expected";
import { H2H_PARAMS, ROBUST_PARAMS } from "@/engine/standings-opt/objective";
import { rotoPlayers } from "@/engine/recommendation/with-roto";
import { evaluateRosters, replayDraft, type ReplayPick } from "@/engine/standings-opt/replay";
import { viewLinesOf } from "@/engine/standings-opt/lines";
import { computeRecommendations, computeStandings, resetRecommendationCaches } from "@/server/recommendations";
import { computeH2hTable } from "@/server/standings";
import { GET as standingsGet } from "@/app/api/draft/[id]/standings/route";
import { makeRecord } from "./fixtures";

function universe(n = 220): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  for (let i = 0; i < n; i++) {
    const q = 1 - i / n;
    const k = i % 5;
    out.push(
      makeRecord({
        id: `u${i}`, name: `Player ${i}`, positions: [(["PG", "SG", "SF", "PF", "C"] as const)[k]],
        projection: {
          pts: 8 + 18 * q + (k % 2), threePm: 0.5 + 2 * q * (k < 2 ? 1.3 : 0.4), reb: 3 + 8 * q * (k > 2 ? 1.4 : 0.5),
          ast: 1.5 + 6 * q * (k < 2 ? 1.4 : 0.4), stl: 0.5 + q, blk: 0.2 + 1.2 * q * (k > 2 ? 1.5 : 0.3), tov: 1 + 2 * q,
        },
        market: { yahooAdp: i + 1, rank: i + 1, adpStdDev: 4 },
      }),
    );
  }
  return out;
}

function inputFor(recs: PlayerRecord[], over: Partial<RecommendInput> = {}): RecommendInput {
  const strategy = defaultStrategy();
  const { valuations } = computeValuations(recs, valuationOptionsOf(strategy));
  return { records: recs, valuations, draftedIds: [], userRosterIds: [], currentPick: 1, userNextPick: 5, isUserOnClock: false, survival: null, strategy, config: { teams: 8 }, rounds: 8, ...over };
}
const ctx = (over = {}) => ({ teams: 8, rounds: 8, userSlot: 5, rosters: Array.from({ length: 8 }, () => [] as string[]), seed: 9, sims: 40, ...over });

describe("scorePlayers with a standings analysis", () => {
  const recs = universe();
  it("without roto the classic dimensions are unchanged (no roto fields)", () => {
    const s = scorePlayers(inputFor(recs));
    expect(s[0].roto).toBeUndefined();
  });
  it("adds the Roto dimension (0-100), re-normalizes the other weights and leads the reason with the standings sentence", () => {
    const inp = inputFor(recs);
    const analysis = analyzeRoto({ ...ctx(), currentPick: 1, players: rotoPlayers(recs, inp.valuations), objective: H2H_PARAMS, candidates: ["u0", "u1", "u2", "u30"], autoByAdp: 0, autoBySurrogate: 0 });
    const classic = scorePlayers(inp);
    const withRoto = scorePlayers({ ...inp, roto: analysis });
    const by = (xs: typeof classic, id: string) => xs.find((s) => s.playerId === id)!;
    for (const id of ["u0", "u1", "u2", "u30"]) {
      const s = by(withRoto, id);
      expect(s.roto).toBeGreaterThanOrEqual(0);
      expect(s.roto).toBeLessThanOrEqual(100);
      expect(s.dWinProb).toBe(analysis.candidates[id].dWinProb);
      // draftScore = (1 - 0.45) classic + 0.45 roto
      expect(s.draftScore).toBeCloseTo(0.55 * by(classic, id).draftScore + 0.45 * s.roto!, 6);
      expect(s.reason).toMatch(/weekly win odds|Little change|Costs weekly/);
    }
    // the best-gain candidate gets Roto 100
    const best = Object.values(analysis.candidates).sort((a, b) => b.gain - a.gain)[0];
    expect(by(withRoto, best.playerId).roto).toBe(100);
    // a non-evaluated player sits below every evaluated one
    expect(by(withRoto, "u100").roto!).toBeLessThanOrEqual(Math.min(...["u0", "u1", "u2", "u30"].map((id) => by(withRoto, id).roto!)));
    // the weight is configurable and 0 reproduces the classic draft score
    const zero = scorePlayers({ ...inp, roto: analysis, config: { teams: 8, rotoWeight: 0 } });
    expect(by(zero, "u1").draftScore).toBeCloseTo(by(classic, "u1").draftScore, 9);
  });
  it("rotoReason: h2h names the core categories; roto names the weakest view", () => {
    const inp = inputFor(recs);
    const h = analyzeRoto({ ...ctx(), currentPick: 1, players: rotoPlayers(recs, inp.valuations), objective: H2H_PARAMS, candidates: ["u0"], autoByAdp: 0, autoBySurrogate: 0 });
    expect(rotoReason(h, h.candidates.u0)).toMatch(/^(Strengthens your core \(.+\)|Builds toward .+|Little change.*|Costs weekly.*)[:.]?/);
    expect(rotoReason(h, h.candidates.u0)).toMatch(/\d+% → \d+%/);
    const r = analyzeRoto({ ...ctx(), currentPick: 1, players: rotoPlayers(recs, inp.valuations), objective: ROBUST_PARAMS, candidates: ["u0"], autoByAdp: 0, autoBySurrogate: 0 });
    expect(rotoReason(r, r.candidates.u0)).toMatch(/^Lifts your weakest view \((Proj|Total|Avg): #\d+ → #\d+\)/);
  });
  it("scoreWithRoto: runs both phases for a standings objective; classic objective is plain scorePlayers", () => {
    const inp = inputFor(recs);
    const a = scoreWithRoto(inp, ctx());
    expect(a.roto).not.toBeNull();
    expect(a.scores.some((s) => s.roto !== undefined)).toBe(true);
    expect(a.scores.filter((s) => s.recommendation === "TAKE" || s.recommendation === "DRAFT").length).toBeGreaterThan(0);
    const classicStrategy = applyStrategyPatch(defaultStrategy(), { objective: "classic" });
    const c = scoreWithRoto(inputFor(recs, { strategy: classicStrategy }), ctx());
    expect(c.roto).toBeNull();
    expect(c.scores.every((s) => s.roto === undefined)).toBe(true);
    // deterministic
    const b = scoreWithRoto(inp, ctx());
    expect(b.scores.map((s) => [s.playerId, s.riskAdjusted])).toEqual(a.scores.map((s) => [s.playerId, s.riskAdjusted]));
  });
  it("survival logic is kept: a slightly lower-gain player with 5% survival beats a top-gain player with 95% survival", () => {
    const inp = inputFor(recs, { isUserOnClock: true, currentPick: 5 });
    const analysis = analyzeRoto({ ...ctx(), currentPick: 5, players: rotoPlayers(recs, inp.valuations), objective: H2H_PARAMS, candidates: ["u3", "u4"], autoByAdp: 0, autoBySurrogate: 0 });
    const surv = Object.fromEntries(recs.map((r) => [r.player.id, 0.5]));
    surv.u3 = 0.95;
    surv.u4 = 0.05;
    const flat = { ...analysis, candidates: { u3: { ...analysis.candidates.u3, gain: 0 }, u4: { ...analysis.candidates.u4, gain: -0.1 } } };
    const out = scorePlayers({ ...inp, roto: flat, survival: surv, draftedIds: ["u0", "u1", "u2", "x"].slice(0, 3) });
    expect(out.find((s) => s.recommendation === "DRAFT")?.playerId).toBe("u4");
  });
});

describe("replay harness (synthetic draft)", () => {
  const recs = universe(120);
  const teams = 6, rounds = 5, userSlot = 4;
  const order = (p: number) => { const r = Math.floor((p - 1) / teams) + 1; const i = (p - 1) % teams; return r % 2 === 1 ? i + 1 : teams - i; };
  const picks: ReplayPick[] = Array.from({ length: teams * rounds }, (_, i) => ({ pick: i + 1, teamSlot: order(i + 1), playerId: `u${i}` })); // ADP order
  const base = { teams, rounds, userSlot, picks, universe: recs.map((r) => r.player.id), adpOf: (id: string) => Number(id.slice(1)) };

  it("the identity chooser reproduces the recorded draft", () => {
    const r = replayDraft({ ...base, choose: (st) => picks.find((p) => p.pick === st.currentPick)!.playerId });
    expect(r.conflicts).toEqual([]);
    expect(r.rosters[userSlot - 1]).toEqual(picks.filter((p) => p.teamSlot === userSlot).map((p) => p.playerId));
  });
  it("when the user takes a player an opponent was going to take later, that opponent gets the best undrafted ADP not recorded later", () => {
    const mine = picks.filter((p) => p.teamSlot === userSlot).map((p) => p.pick);
    // at his first pick (#4) the user takes the player recorded at #10 (u9)
    const r = replayDraft({ ...base, choose: (st) => (st.currentPick === mine[0] ? "u9" : picks.find((p) => p.pick === st.currentPick)!.playerId) });
    expect(r.userPicks[0]).toBe("u9");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ pick: 10, wanted: "u9" });
    const rec = picks.find((p) => p.playerId === r.conflicts[0].gave);
    expect(rec === undefined || rec.pick < 10).toBe(true); // never a player recorded at a later pick; nobody is drafted twice
    const all = r.rosters.flat();
    expect(new Set(all).size).toBe(all.length);
    // the user's own pick #4 player (u3) stays available for the opponents only if recorded later: it was not, so nothing else moved
    expect(r.rosters.every((x) => x.length === rounds)).toBe(true);
  });
  it("a chooser that returns a drafted player is rejected", () => {
    expect(() => replayDraft({ ...base, choose: () => "u0" })).toThrow();
  });
  it("evaluateRosters: a stacked user team ranks first everywhere and wins most weekly matchups", () => {
    const lineOf = (id: string) => viewLinesOf(recs.find((r) => r.player.id === id)!);
    const stacked = replayDraft({ ...base, choose: (st) => base.universe.find((id) => !st.draftedIds.includes(id))! }); // best available at every turn
    const rep = evaluateRosters(stacked.rosters, userSlot - 1, lineOf);
    expect(rep.roto.proj.rank).toBeLessThanOrEqual(2);
    expect(rep.winProb).toBeGreaterThan(0.5);
    expect(rep.allTop5).toBe(true);
    expect(rep.h2hRank).toBeLessThanOrEqual(2);
  });
});

describe("server: standings in the recommendations and the standings route", () => {
  let db: Db;
  let draftId: number;
  beforeEach(() => {
    resetRecommendationCaches();
    db = createDb(":memory:");
    (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
    seedFromRecords(db, universe());
    draftId = createDraft(db, { teams: 14, userSlot: 5, rounds: 13 }).id;
  });

  it("default objective feeds the Roto dimension and reports the projected finish; classic does not", () => {
    for (let i = 0; i < 4; i++) recordPick(db, draftId, `u${i}`, "yahoo-dom");
    const r = computeRecommendations(db, draftId, { limit: 10 })!;
    expect(r.objective).toBe("h2h");
    expect(r.standings).not.toBeNull();
    expect(r.standings!.userPicksLeft).toBe(13);
    expect(r.top.some((t) => t.roto !== null)).toBe(true);
    expect(r.top[0].reason).toMatch(/weekly win odds|Little change|Costs weekly/);
    updateDraftStrategy(db, draftId, { objective: "classic" });
    const c = computeRecommendations(db, draftId, { limit: 10 })!;
    expect(c.objective).toBe("classic");
    expect(c.top.every((t) => t.roto === null)).toBe(true);
    expect(c.standings).toBeNull();
    updateDraftStrategy(db, draftId, { objective: "robust" });
    const rb = computeRecommendations(db, draftId, { limit: 10 })!;
    expect(rb.top[0].reason).toMatch(/Lifts your weakest view|Little change|Costs|weekly/i);
  });

  it("standings route: analysis with candidates, outlook lines, and the H2H table", async () => {
    for (let i = 0; i < 4; i++) recordPick(db, draftId, `u${i}`, "yahoo-dom");
    const res = await standingsGet(new Request("http://x/api/draft/1/standings"), { params: Promise.resolve({ id: String(draftId) }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.analysis.candidates).length).toBeGreaterThan(10);
    expect(body.outlook.weeklyLine).toMatch(/^Weekly outlook/);
    const t = await (await standingsGet(new Request("http://x/api/draft/1/standings?table=1"), { params: Promise.resolve({ id: String(draftId) }) })).json();
    expect(t.rows).toHaveLength(14);
    expect(t.rows.filter((r: { isUser: boolean }) => r.isUser)).toHaveLength(1);
    const missing = await standingsGet(new Request("http://x/api/draft/999/standings"), { params: Promise.resolve({ id: "999" }) });
    expect(missing.status).toBe(404);
    expect(computeStandings(db, 999)).toBeNull();
    expect(computeH2hTable(db, 999)).toBeNull();
  });

  it("a finished draft still gets its final outlook (exact, no candidates)", () => {
    const d = createDraft(db, { teams: 2, userSlot: 1, rounds: 2 });
    for (let i = 0; i < 4; i++) recordPick(db, d.id, `u${i}`, "manual");
    const s = computeStandings(db, d.id)!;
    expect(s.analysis).toBeNull();
    expect(s.outlook!.userPicksLeft).toBe(0);
    expect(s.outlook!.views.proj.rank).toBeGreaterThanOrEqual(1);
  });
});
