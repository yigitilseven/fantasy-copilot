import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { createDraft, getAllPlayerRecords, getDraft, recordPick, updateDraftStrategy } from "@/db/repository";
import { yahooProjections } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { ROTO_CATEGORIES, computeStandings, rankPoints, rotoStats, standingsFromStats, totalsOf, type RotoStats } from "@/engine/evaluation/standings";
import { computeEvaluation, computeOutlook } from "@/server/evaluation";
import { resetRecommendationCaches, computeRecommendations } from "@/server/recommendations";
import { GET as evalGet } from "@/app/api/draft/[id]/evaluation/route";
import { PATCH as stratPatch } from "@/app/api/draft/[id]/strategy/route";
import { parseStrategy } from "@/engine/recommendation/strategy";
import { makeRecord } from "./fixtures";

const stats = (o: Partial<RotoStats>): RotoStats => ({ "FG%": 0.45, "FT%": 0.78, "3PTM": 1000, PTS: 10000, REB: 4000, AST: 2500, ST: 700, BLK: 400, TO: 1300, ...o });

describe("rankPoints", () => {
  it("best gets N, worst 1; ties share the average (3.5 / 8.5 style)", () => {
    expect(rankPoints([10, 30, 20, 40])).toEqual([1, 3, 2, 4]);
    expect(rankPoints([10, 30, 30, 40])).toEqual([1, 2.5, 2.5, 4]);
    // 14 teams: ranks 3 & 4 from the bottom tie -> 3.5 each; ranks 8 & 9 tie -> 8.5 each
    const v = [1, 2, 3, 3, 5, 6, 7, 8, 8, 10, 11, 12, 13, 14];
    expect(rankPoints(v)).toEqual([1, 2, 3.5, 3.5, 5, 6, 7, 8.5, 8.5, 10, 11, 12, 13, 14]);
    expect(rankPoints([5, 5, 5])).toEqual([2, 2, 2]);
  });
  it("lower is better inverts (turnovers)", () => {
    expect(rankPoints([10, 30, 20], true)).toEqual([3, 1, 2]);
    expect(rankPoints([10, 10, 30], true)).toEqual([2.5, 2.5, 1]);
  });
});

describe("standingsFromStats (Yahoo-like table)", () => {
  // 6 teams; deliberately includes ties, a TO inversion and displayed-precision ties (.4801 vs .4799 both show .480)
  const teams = [
    { id: "A", stats: stats({ "FG%": 0.4801, "FT%": 0.8, "3PTM": 1500, PTS: 14000, REB: 5000, AST: 3000, ST: 900, BLK: 500, TO: 1200 }) },
    { id: "B", stats: stats({ "FG%": 0.4799, "FT%": 0.79, "3PTM": 1500, PTS: 13000, REB: 5200, AST: 2800, ST: 950, BLK: 450, TO: 1400 }) },
    { id: "C", stats: stats({ "FG%": 0.47, "FT%": 0.8, "3PTM": 1300, PTS: 12000, REB: 4800, AST: 3200, ST: 800, BLK: 600, TO: 1100 }) },
    { id: "D", stats: stats({ "FG%": 0.49, "FT%": 0.75, "3PTM": 1200, PTS: 11000, REB: 5400, AST: 2600, ST: 850, BLK: 400, TO: 1300 }) },
    { id: "E", stats: stats({ "FG%": 0.46, "FT%": 0.82, "3PTM": 1100, PTS: 15000, REB: 4600, AST: 2400, ST: 1000, BLK: 550, TO: 1200 }) },
    { id: "F", stats: stats({ "FG%": 0.45, "FT%": 0.7, "3PTM": 1000, PTS: 10000, REB: 4400, AST: 2200, ST: 700, BLK: 300, TO: 1500 }) },
  ];
  const t = standingsFromStats(teams);
  const by = (id: string) => t.find((x) => x.id === id)!;

  it("FG% ties on the displayed 3 decimals; counting ties average", () => {
    expect(by("A").points["FG%"]).toBe(4.5);
    expect(by("B").points["FG%"]).toBe(4.5);
    expect(by("D").points["FG%"]).toBe(6);
    expect(by("A").points["3PTM"]).toBe(5.5);
    expect(by("B").points["3PTM"]).toBe(5.5);
  });
  it("turnovers: fewer is better, with the tie averaged", () => {
    expect(by("C").points.TO).toBe(6);
    expect(by("A").points.TO).toBe(4.5);
    expect(by("E").points.TO).toBe(4.5);
    expect(by("F").points.TO).toBe(1);
    expect(by("B").points.TO).toBe(2);
  });
  it("totals are the sum of category points; every category hands out N(N+1)/2 points; ranks use competition ranking", () => {
    for (const r of t) expect(r.total).toBe(ROTO_CATEGORIES.reduce((s, c) => s + r.points[c], 0));
    expect(t.reduce((s, r) => s + r.total, 0)).toBe(9 * 21);
    expect(t.map((r) => r.rank).sort()).toEqual([...t.map((r) => r.rank)].sort());
    const best = [...t].sort((a, b) => b.total - a.total)[0];
    expect(best.rank).toBe(1);
  });
});

describe("computeStandings", () => {
  const line = (o: Partial<Parameters<typeof totalsOf>[0]> = {}) => ({ games: 10, minutes: 30, pts: 20, fgm: 8, fga: 16, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 1, tov: 2, ...o });
  it("FG% / FT% are Σmakes/Σattempts; missing data contributes nothing; rosters may differ in size", () => {
    const lines: Record<string, ReturnType<typeof totalsOf>> = {
      a: totalsOf(line({ fgm: 10, fga: 10 })), // 100/100
      b: totalsOf(line({ fgm: 0, fga: 90 })), //   0/900
      c: totalsOf(line({ fgm: 5, fga: 10 })),
    };
    const s = computeStandings([{ id: 1, playerIds: ["a", "b"] }, { id: 2, playerIds: ["c", "ghost"] }, { id: 3, playerIds: [] }], (id) => lines[id] ?? null);
    expect(s[0].stats["FG%"]).toBeCloseTo(100 / 1000); // not (1 + 0) / 2
    expect(s[1].stats["FG%"]).toBeCloseTo(0.5);
    expect(s[1]).toMatchObject({ players: 1, rosterSize: 2 });
    expect(s[2].stats).toEqual(rotoStats({ fgm: 0, fga: 0, ftm: 0, fta: 0, threePm: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 }));
  });
  it("'avg' mode sums per-game values, 'total' multiplies by games", () => {
    const l = line({ games: 50, pts: 10 });
    expect(totalsOf(l, "total").pts).toBe(500);
    expect(totalsOf(l, "avg").pts).toBe(10);
  });
});

// ------------------------------------------------------------------ DB-backed: evaluation, endpoint, strategy persistence
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const get = (id: number, qs = "") => evalGet(new Request(`http://localhost:3000/api/draft/${id}/evaluation${qs}`), ctx(id));

let db: Db;
let draftId: number;
beforeEach(() => {
  resetRecommendationCaches();
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  const recs = Array.from({ length: 12 }, (_, i) => makeRecord({ id: `p${i}`, name: `Nobody ${i}`, market: { rank: i + 1, yahooAdp: i + 1 } }));
  seedFromRecords(db, recs);
  db.insert(yahooProjections)
    .values(
      recs.map((r, i) => ({
        yahooId: `y${i}`, playerId: r.player.id, name: r.player.name, nbaTeam: "TST", positions: "SF", gp: 70, fgPct: 0.5, ftPct: 0.8, threePm: 100 + 10 * i,
        pts: 1000 + 100 * i, reb: 400, ast: 300, stl: 70, blk: 30, tov: 140, xrank: i + 1, rank: i + 1, adp: i + 1, season: "2026-27", capturedAt: "2026-10-09T00:00:00Z",
      })),
    )
    .run();
  draftId = createDraft(db, { teams: 4, userSlot: 2, rounds: 3 }).id;
  // 11 of 12 picks: snake order 1,2,3,4 | 4,3,2,1 | 1,2,3,(4 missing)
  for (let i = 0; i < 11; i++) recordPick(db, draftId, `p${i}`);
});

describe("evaluation", () => {
  it("scores the rosters on Yahoo projections and copes with a short roster", () => {
    const e = computeEvaluation(db, draftId, { view: "proj" })!;
    expect(e.standings).toHaveLength(4);
    expect(e.standings.map((s) => s.rosterSize).sort()).toEqual([2, 3, 3, 3]);
    expect(e.you?.label).toBe("Your Team");
    expect(e.standings.reduce((s, r) => s + r.total, 0)).toBe(9 * 10);
    // players with no 2025-26 stats (made-up names) contribute nothing to the actual views, blend falls back to Yahoo
    expect(computeEvaluation(db, draftId, { view: "total" })!.you!.stats.PTS).toBe(0);
    expect(computeEvaluation(db, draftId, { view: "blend", weight: 0.3 })!.you!.stats.PTS).toBe(computeEvaluation(db, draftId, { view: "proj" })!.you!.stats.PTS);
  });

  it("returns null for an unknown draft", () => {
    expect(computeEvaluation(db, 999)).toBeNull();
    expect(computeOutlook(db, 999)).toBeNull();
  });

  it("outlook: rank per view + a sweep over w = 0..1", () => {
    const o = computeOutlook(db, draftId)!;
    expect(o.sweep.map((s) => s.weight)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(o.views.proj).not.toBeNull();
    expect(o.sweep.every((s) => s.rank >= 1 && s.rank <= 4)).toBe(true);
  });

  it("GET /api/draft/[id]/evaluation: views, w, validation, 404", async () => {
    const r = await get(draftId, "?view=proj");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ draftId, view: "proj", teams: 4, userSlot: 2 });
    expect(b.standings[0]).toHaveProperty("points");
    expect((await (await get(draftId)).json()).view).toBe("blend");
    expect((await (await get(draftId, "?view=blend&w=0.2")).json()).weight).toBe(0.2);
    expect((await (await get(draftId, "?view=outlook")).json()).sweep).toHaveLength(6);
    expect((await get(draftId, "?view=nope")).status).toBe(400);
    expect((await get(draftId, "?w=2")).status).toBe(400);
    expect((await get(999)).status).toBe(404);
  });
});

describe("strategy: projectionWeight / robustness persistence", () => {
  const patch = (body: unknown) =>
    stratPatch(new Request(`http://localhost:3000/api/draft/${draftId}/strategy`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(draftId));

  it("defaults to 0.6 / off, including for strategies saved before the field existed", () => {
    expect(getDraft(db, draftId)!.strategy).toMatchObject({ projectionWeight: 0.6 });
    expect(getDraft(db, draftId)!.strategy!.robustness).toBeUndefined();
    expect(parseStrategy(JSON.stringify({ preset: "punt-ft", riskTolerance: 0.2 })).projectionWeight).toBe(0.6);
  });

  it("PATCH persists the weight, survives preset changes, and reaches the recommendations", async () => {
    const res = await patch({ projectionWeight: 0.8 });
    expect(res.status).toBe(200);
    expect((await res.json()).strategy.projectionWeight).toBe(0.8);
    expect(getDraft(db, draftId)!.strategy!.projectionWeight).toBe(0.8);
    updateDraftStrategy(db, draftId, { preset: "punt-ft" });
    expect(getDraft(db, draftId)!.strategy).toMatchObject({ preset: "punt-ft", projectionWeight: 0.8 });
    expect(computeRecommendations(db, draftId)!.projection).toEqual({ mode: "fixed", weight: 0.8, robustness: 0, robustnessMode: "auto" });
    await patch({ robustness: 0.25 });
    expect(getDraft(db, draftId)!.strategy!.robustness).toBe(0.25);
    expect(computeRecommendations(db, draftId)!.projection.robustness).toBe(0.25);
    await patch({ robustness: 0 });
    expect(getDraft(db, draftId)!.strategy!.robustness).toBeUndefined();
  });

  it("rejects out-of-range values", async () => {
    expect((await patch({ projectionWeight: 1.5 })).status).toBe(400);
    expect((await patch({ projectionWeight: -0.1 })).status).toBe(400);
    expect((await patch({ robustness: 3 })).status).toBe(400);
  });
});

// ------------------------------------------------------------------ reproduction of the user's real draft 7 (skipped without the data)
const DRAFT7_USER_ROSTER = ["Karl-Anthony Towns", "Anthony Davis", "Onyeka Okongwu", "Dyson Daniels", "Michael Porter Jr.", "Tyler Herro", "Jaime Jaquez Jr.", "Reed Sheppard", "Christian Braun", "Ajay Mitchell", "Grayson Allen", "Scoot Henderson", "Keldon Johnson"];

function openDraft7Copy(): Db | null {
  const src = path.join(process.cwd(), "data", "fantasy.sqlite");
  if (!fs.existsSync(src) || !fs.existsSync(path.join(process.cwd(), "data", "cache", "nba-stats-2025-26.json"))) return null;
  try {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "draft7-")), "copy.sqlite");
    const live = new Database(src, { readonly: true, fileMustExist: true });
    fs.writeFileSync(tmp, live.serialize()); // snapshot; never touches the live file
    live.close();
    const copy = createDb(tmp);
    const d = getDraft(copy, 7);
    if (!d || d.picks.length < 150 || !copy.select().from(yahooProjections).limit(1).all().length) return null;
    const names = new Map(getAllPlayerRecords(copy).map((r) => [r.player.id, r.player.name]));
    const mine = d.picks.filter((p) => p.teamSlot === d.userSlot).map((p) => names.get(p.playerId)).sort();
    return JSON.stringify(mine) === JSON.stringify([...DRAFT7_USER_ROSTER].sort()) ? copy : null; // only the exact roster Yahoo's numbers were taken from
  } catch {
    return null;
  }
}
const draft7 = openDraft7Copy();
/** Yahoo's projection numbers above are from the Oct 9 capture; once projections are recaptured (Yahoo updates them), the proj view can't match. */
const projCapturedForDraft7 = (() => {
  if (!draft7) return false;
  const latest = draft7.select({ at: yahooProjections.capturedAt }).from(yahooProjections).all().reduce((m, r) => (r.at && r.at > m ? r.at : m), "");
  return latest !== "" && latest <= "2026-10-09T23:59:59Z";
})();

describe.skipIf(!draft7)("reproduces Yahoo's standings table for the user's draft 7 (slot 13)", () => {
  // these compare against the real 2025-26 stats: use the machine's data/cache, not the test fixture cache
  const fixtureCache = process.env.STATS_CACHE_DIR;
  beforeAll(() => {
    process.env.STATS_CACHE_DIR = path.join(process.cwd(), "data", "cache");
  });
  afterAll(() => {
    process.env.STATS_CACHE_DIR = fixtureCache;
  });
  const within = (x: number, target: number, rel: number) => expect(Math.abs(x - target) / target).toBeLessThanOrEqual(rel);
  // Yahoo's "Your Team" rows: proj .490/.815/1571/14482/5266/3095/1002/515/1392; 2025-26 totals .480/.813/1253/11782/4406/2629/812/346/1301;
  // 2025-26 averages .479/.821/21.9/210.7/76.4/45.1/13.9/6.7/23.0.
  it.skipIf(!projCapturedForDraft7)("2026-27 Proj view matches every category (only with the Oct 9 projections capture)", () => {
    const s = computeEvaluation(draft7!, 7, { view: "proj" })!.you!.stats;
    expect(s["FG%"]).toBeCloseTo(0.49, 3);
    expect(s["FT%"]).toBeCloseTo(0.815, 3);
    for (const [c, t] of [["3PTM", 1571], ["PTS", 14482], ["REB", 5266], ["AST", 3095], ["ST", 1002], ["BLK", 515], ["TO", 1392]] as const) within(s[c], t, 0.003);
  });
  it("2025-26 Total view is within ~3% per category", () => {
    const s = computeEvaluation(draft7!, 7, { view: "total" })!.you!.stats;
    expect(Math.abs(s["FG%"] - 0.48)).toBeLessThan(0.003);
    expect(Math.abs(s["FT%"] - 0.813)).toBeLessThan(0.008);
    for (const [c, t] of [["3PTM", 1253], ["PTS", 11782], ["REB", 4406], ["AST", 2629], ["ST", 812], ["BLK", 346], ["TO", 1301]] as const) within(s[c], t, 0.03);
  });
  it("2025-26 Average view sums per-game values like Yahoo", () => {
    const s = computeEvaluation(draft7!, 7, { view: "avg" })!.you!.stats;
    expect(Math.abs(s["FG%"] - 0.479)).toBeLessThan(0.003);
    for (const [c, t] of [["3PTM", 21.9], ["PTS", 210.7], ["REB", 76.4], ["AST", 45.1], ["ST", 13.9], ["BLK", 6.7], ["TO", 23.0]] as const) within(s[c], t, 0.03);
  });
  it("14 teams, points add up (all 182 picks recorded -> every roster has 13)", () => {
    const e = computeEvaluation(draft7!, 7, { view: "proj" })!;
    expect(e.standings).toHaveLength(14);
    expect(e.standings.map((r) => r.rosterSize).sort((a, b) => a - b)[0]).toBe(13);
    expect(e.standings.reduce((s, r) => s + r.total, 0)).toBe(9 * 105);
  });
});
