import { describe, expect, it } from "vitest";
import { ROTO_CATEGORIES, standingsFromStats, rotoStats, type TotalsLine } from "@/engine/evaluation/standings";
import { createRng } from "@/engine/draft/rng";
import { F, NF, OPT_VIEWS, VIEW_COUNT, viewLinesOf } from "@/engine/standings-opt/lines";
import { NCAT, makeScratch, rotoView, statsInto } from "@/engine/standings-opt/rank";
import { H2H_PARAMS, MAX_TOTAL_PARAMS, ROBUST_PARAMS, objectiveOf } from "@/engine/standings-opt/objective";
import { catWinInto, h2hTable, weekStatsInto, winAtLeast } from "@/engine/standings-opt/h2h";
import { analyzeRoto, type RotoInput, type RotoPlayerInput } from "@/engine/standings-opt/expected";
import { phi } from "@/engine/standings-opt/phi";
import { outlookOf } from "@/engine/standings-opt/summary";
import { makeRecord } from "./fixtures";

const toLine = (a: Float64Array, v: number): TotalsLine => ({
  fgm: a[v * NF + F.fgm], fga: a[v * NF + F.fga], ftm: a[v * NF + F.ftm], fta: a[v * NF + F.fta], threePm: a[v * NF + F.threePm], pts: a[v * NF + F.pts],
  reb: a[v * NF + F.reb], ast: a[v * NF + F.ast], stl: a[v * NF + F.stl], blk: a[v * NF + F.blk], tov: a[v * NF + F.tov],
});

describe("rotoView == the Yahoo evaluator (standingsFromStats)", () => {
  it("matches points, totals and ranks on random teams incl. ties, in the total and the avg (1 decimal) views", () => {
    const rng = createRng(42);
    const teams = 14;
    for (let view = 0; view < VIEW_COUNT; view++) {
      const T = new Float64Array(teams * VIEW_COUNT * NF);
      for (let t = 0; t < teams; t++) {
        for (let f = 0; f < NF; f++) {
          // coarse values so that ties are frequent
          const base = view === 2 ? 10 : 800;
          T[(t * VIEW_COUNT + view) * NF + f] = Math.round(base * (0.8 + 0.4 * rng.next()) / 5) * 5 / (f === F.fga || f === F.fta ? 1 : 1);
        }
        // makes <= attempts
        T[(t * VIEW_COUNT + view) * NF + F.fgm] = T[(t * VIEW_COUNT + view) * NF + F.fga] * 0.45;
        T[(t * VIEW_COUNT + view) * NF + F.ftm] = T[(t * VIEW_COUNT + view) * NF + F.fta] * 0.75;
      }
      T[(1 * VIEW_COUNT + view) * NF + F.pts] = T[(0 * VIEW_COUNT + view) * NF + F.pts]; // force a tie
      const s = makeScratch(teams);
      const expected = standingsFromStats(
        Array.from({ length: teams }, (_, t) => ({ id: t, stats: rotoStats(toLine(T.subarray((t * VIEW_COUNT) * NF, (t * VIEW_COUNT + VIEW_COUNT) * NF), view)) })),
        { decimals: view === 2 ? { "3PTM": 1, PTS: 1, REB: 1, AST: 1, ST: 1, BLK: 1, TO: 1 } : undefined },
      );
      for (let user = 0; user < teams; user++) {
        const rank = rotoView(T, teams, view, user, s);
        expect(rank).toBe(expected[user].rank);
        expect(s.total[user]).toBeCloseTo(expected[user].total, 9);
        ROTO_CATEGORIES.forEach((c, i) => expect(s.points[user * NCAT + i]).toBeCloseTo(expected[user].points[c], 9));
      }
    }
  });
});

describe("viewLinesOf", () => {
  const comp = (pts: number, games: number) => ({ games, minutes: 30, pts, fgm: 5, fga: 10, ftm: 2, fta: 3, threePm: 1, reb: 4, ast: 3, stl: 1, blk: 1, tov: 2 });
  it("proj = Yahoo totals, total = 2025-26 totals, avg = 2025-26 per game; missing lines contribute nothing", () => {
    const r = makeRecord({ id: "a" });
    r.projection.components = { yahoo: comp(20, 70), actual: comp(18, 60) };
    const l = viewLinesOf(r);
    expect(l[0 * NF + F.pts]).toBe(20 * 70);
    expect(l[1 * NF + F.pts]).toBe(18 * 60);
    expect(l[2 * NF + F.pts]).toBe(18);
    const noYahoo = makeRecord({ id: "b" });
    noYahoo.projection.components = { yahoo: null, actual: comp(18, 60) };
    expect(viewLinesOf(noYahoo)[F.pts]).toBe(0);
    expect(viewLinesOf(noYahoo, { fallbackProj: true })[F.pts]).toBeCloseTo(noYahoo.projection.pts * noYahoo.projection.games);
    const rookie = makeRecord({ id: "c" });
    rookie.projection.components = { yahoo: comp(12, 70), actual: null };
    expect(viewLinesOf(rookie)[1 * NF + F.pts]).toBe(0);
  });
});

describe("objective math", () => {
  it("h2h: 100·(weighted mean win + μ·min win) − ν·rank places outside the top 5", () => {
    const wins = [0.8, 0.6, 0.7];
    const j = objectiveOf([0, 0, 0], [3, 7, 5], wins, { ...H2H_PARAMS, mu: 0.5, nu: 0.5 });
    expect(j).toBeCloseTo(100 * (0.7 + 0.5 * 0.6) - 0.5 * 2, 9);
    expect(objectiveOf([0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], { ...H2H_PARAMS, weights: [2, 1, 1], mu: 0, nu: 0 })).toBeCloseTo(50, 9);
  });
  it("roto: Σ w p + μ min p − ν Σ max(0, rank − 5); max-total is the plain sum", () => {
    expect(objectiveOf([70, 60, 80], [4, 6, 9], [0, 0, 0], ROBUST_PARAMS)).toBeCloseTo(210 + 60 - 2 * (1 + 4), 9);
    expect(objectiveOf([70, 60, 80], [4, 6, 9], [0, 0, 0], MAX_TOTAL_PARAMS)).toBe(210);
  });
  it("the worst view gets priority: lifting a view outside the top 5 beats the same points in a safe view", () => {
    const base = { pts: [70, 70, 70], ranks: [2, 7, 2] };
    const liftWeak = objectiveOf([70, 75, 70], [2, 5, 2], [0, 0, 0], ROBUST_PARAMS);
    const liftSafe = objectiveOf([75, 70, 70], [1, 7, 2], [0, 0, 0], ROBUST_PARAMS);
    expect(liftWeak).toBeGreaterThan(liftSafe);
    expect(objectiveOf(base.pts, base.ranks, [0, 0, 0], ROBUST_PARAMS)).toBeLessThan(liftWeak);
  });
});

describe("weekly H2H model", () => {
  it("Poisson-binomial matches brute force", () => {
    const p = new Float64Array([0.9, 0.2, 0.5, 0.7, 0.35, 0.6, 0.05, 0.95, 0.5]);
    let exact = 0;
    for (let m = 0; m < 1 << 9; m++) {
      let pr = 1, wins = 0;
      for (let c = 0; c < 9; c++) {
        const w = (m >> c) & 1;
        pr *= w ? p[c] : 1 - p[c];
        wins += w;
      }
      if (wins >= 5) exact += pr;
    }
    expect(winAtLeast(p, 0)).toBeCloseTo(exact, 12);
    expect(winAtLeast(new Float64Array(9).fill(0.5), 0)).toBeCloseTo(0.5, 12);
  });
  it("Φ table accuracy", () => {
    expect(phi(0)).toBeCloseTo(0.5, 6);
    expect(phi(1.96)).toBeCloseTo(0.975, 4);
    expect(phi(-9)).toBe(0);
  });
  const lineTeam = (scale: number, tov: number): Float64Array => {
    const t = new Float64Array(VIEW_COUNT * NF);
    for (let v = 0; v < VIEW_COUNT; v++) {
      const k = v === 2 ? 1 : 70; // avg view = per-game sums, total views = season totals
      t.set([3000 * scale / 70 * k, 6500 * scale / 70 * k, 1500 * scale / 70 * k, 2000 * scale / 70 * k, 800 * scale / 70 * k, 8000 * scale / 70 * k, 3000 * scale / 70 * k, 2000 * scale / 70 * k, 600 * scale / 70 * k, 400 * scale / 70 * k, tov * scale / 70 * k], v * NF);
    }
    return t;
  };
  it("a stronger team wins more categories; TO is won by the LOWER value; equal teams are 50/50", () => {
    const mean = new Float64Array(2 * NCAT), sd = new Float64Array(2 * NCAT), out = new Float64Array(NCAT);
    const a = lineTeam(70, 900), b = lineTeam(70, 1100);
    weekStatsInto(a, 0, 0, mean, sd, 0);
    weekStatsInto(b, 0, 0, mean, sd, NCAT);
    catWinInto(mean, sd, 0, mean, sd, NCAT, out, 0);
    expect(out[NCAT - 1]).toBeGreaterThan(0.9); // fewer turnovers wins
    expect(out[3]).toBeCloseTo(0.5, 6); // same PTS
    const strong = lineTeam(105, 900);
    weekStatsInto(strong, 0, 0, mean, sd, NCAT);
    catWinInto(mean, sd, 0, mean, sd, NCAT, out, 0);
    expect(out[3]).toBeLessThan(0.1);
  });
  it("round robin: win probabilities are symmetric (average over teams = 0.5) and ordered by strength", () => {
    const teams = 6;
    const T = new Float64Array(teams * VIEW_COUNT * NF);
    for (let t = 0; t < teams; t++) T.set(lineTeam(60 + 4 * t, 1000), t * VIEW_COUNT * NF);
    for (let v = 0; v < VIEW_COUNT; v++) {
      const rows = h2hTable(T, teams, v);
      expect(rows.reduce((s, r) => s + r.winProb, 0) / teams).toBeCloseTo(0.5, 6);
      expect(rows[teams - 1].winProb).toBeGreaterThan(rows[0].winProb);
      expect(rows[teams - 1].rank).toBe(1);
    }
  });
  it("a hopeless category adds almost nothing: the same stat gain moves the matchup odds far less there than in a swing category", () => {
    const opp = new Float64Array(NCAT), oppSd = new Float64Array(NCAT), me = new Float64Array(NCAT), meSd = new Float64Array(NCAT), p = new Float64Array(NCAT);
    for (let c = 0; c < NCAT; c++) { opp[c] = 100; oppSd[c] = 10; me[c] = 100; meSd[c] = 10; }
    me[8] = 100; // TO equal
    const odds = (mean: Float64Array) => { catWinInto(mean, meSd, 0, opp, oppSd, 0, p, 0); return winAtLeast(p, 0); };
    const hopeless = Float64Array.from(me); hopeless[3] = 40; // PTS: -4 sd
    const hopelessUp = Float64Array.from(hopeless); hopelessUp[3] = 50;
    const swingUp = Float64Array.from(me); swingUp[3] = 110;
    expect(odds(swingUp) - odds(me)).toBeGreaterThan(5 * (odds(hopelessUp) - odds(hopeless)));
  });
});

// ---- expected final standings (Monte Carlo)
function players(n = 140): RotoPlayerInput[] {
  const out: RotoPlayerInput[] = [];
  const rng = createRng(7);
  for (let i = 0; i < n; i++) {
    const q = 1 - i / n;
    const r = makeRecord({
      id: `p${i}`,
      projection: { pts: 6 + 20 * q + 3 * rng.next(), fgm: 2 + 8 * q, fga: 5 + 16 * q, ftm: 1 + 3 * q, fta: 1.5 + 4 * q, threePm: 0.3 + 2 * q * rng.next(), reb: 2 + 8 * q * rng.next(), ast: 1 + 6 * q * rng.next(), stl: 0.4 + q, blk: 0.2 + q * rng.next(), tov: 0.8 + 2 * q },
      market: { yahooAdp: i + 1, rank: i + 1, adpStdDev: 3 },
    });
    out.push({ id: r.player.id, adp: i + 1, adpSd: 3, value: 10 * q, lines: viewLinesOf(r) });
  }
  return out;
}
const baseInput = (over: Partial<RotoInput> = {}): RotoInput => ({
  teams: 6, rounds: 8, userSlot: 3, currentPick: 1, rosters: Array.from({ length: 6 }, () => []), players: players(), seed: 11, sims: 40, objective: H2H_PARAMS, ...over,
});

describe("analyzeRoto", () => {
  it("is deterministic for a seed and changes with another", () => {
    const a = analyzeRoto(baseInput());
    const b = analyzeRoto(baseInput());
    const strip = (x: ReturnType<typeof analyzeRoto>) => JSON.stringify({ ...x, elapsedMs: 0 });
    expect(strip(a)).toBe(strip(b));
    expect(strip(analyzeRoto(baseInput({ seed: 12 })))).not.toBe(strip(a));
  });
  it("evaluates candidates relative to the baseline; the top player beats a scrub", () => {
    const a = analyzeRoto(baseInput({ candidates: ["p0", "p120"], autoByAdp: 0, autoBySurrogate: 0 }));
    expect(Object.keys(a.candidates).sort()).toEqual(["p0", "p120"]);
    expect(a.candidates.p0.gain).toBeGreaterThan(a.candidates.p120.gain);
    expect(a.candidates.p0.dWinProb).toBeGreaterThan(a.candidates.p120.dWinProb);
    expect(a.baseline.h2h.winProb).toBeGreaterThan(0);
    expect(a.baseline.h2h.winProb).toBeLessThan(1);
    expect(a.userPicksLeft).toBe(8);
    expect(a.remainingPicks).toBe(48);
    for (const v of OPT_VIEWS) {
      expect(a.baseline.views[v].rankMedian).toBeGreaterThanOrEqual(1);
      expect(a.baseline.views[v].rankMedian).toBeLessThanOrEqual(6);
    }
  });
  it("roto kind works and reports per-category rank-point deltas", () => {
    const a = analyzeRoto(baseInput({ objective: ROBUST_PARAMS, candidates: ["p1"], autoByAdp: 0, autoBySurrogate: 0 }));
    const c = a.candidates.p1;
    expect(c.views.proj.dCats.PTS).toBeDefined();
    expect(Number.isFinite(c.gain)).toBe(true);
  });
  it("a finished draft is evaluated exactly (one completion, no candidates)", () => {
    const ps = players(60);
    const rosters = Array.from({ length: 6 }, (_, t) => ps.slice(t * 10, t * 10 + 10).map((p) => p.id));
    const a = analyzeRoto(baseInput({ players: ps, rosters, rounds: 10, currentPick: 61 }));
    expect(a.sims).toBe(1);
    expect(a.remainingPicks).toBe(0);
    expect(Object.keys(a.candidates)).toEqual([]);
    // ranks agree with the evaluator
    const T = new Float64Array(6 * VIEW_COUNT * NF);
    rosters.forEach((ids, t) => ids.forEach((id) => { const l = ps.find((p) => p.id === id)!.lines; for (let k = 0; k < l.length; k++) T[t * VIEW_COUNT * NF + k] += l[k]; }));
    const s = makeScratch(6);
    OPT_VIEWS.forEach((v, i) => expect(a.baseline.views[v].rankMedian).toBe(rotoView(T, 6, i, 2, s)));
  });
  it("opponent rosters already drafted are respected: stats of a stacked opponent lower the user's odds", () => {
    const ps = players();
    const empty = analyzeRoto(baseInput({ players: ps, candidates: [], autoByAdp: 0, autoBySurrogate: 0 }));
    const rosters = Array.from({ length: 6 }, () => [] as string[]);
    rosters[0] = ["p0", "p1", "p2"]; // other team has the studs
    const stacked = analyzeRoto(baseInput({ players: ps, rosters, currentPick: 4, candidates: [], autoByAdp: 0, autoBySurrogate: 0 }));
    expect(stacked.baseline.h2h.winProb).toBeLessThan(empty.baseline.h2h.winProb);
  });
  it("outlookOf formats the projected finish and weekly lines", () => {
    const a = analyzeRoto(baseInput({ sims: 20 }));
    const o = outlookOf(a, 6);
    expect(o.finishLine).toMatch(/^Projected finish: Proj #\d+ · Total #\d+ · Avg #\d+$/);
    expect(o.weeklyLine).toMatch(/^Weekly outlook: wins ~\d\.\d cats · beats \d+\/5 teams$/);
    expect(Object.keys(o.h2h.catP)).toEqual(["FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"]);
  });
  it("perf: a full-size decision (14 teams, 13 rounds, ~25 candidates, 3 views) stays well inside the budget", () => {
    const ps = players(260);
    const t0 = performance.now();
    const a = analyzeRoto({ teams: 14, rounds: 13, userSlot: 13, currentPick: 1, rosters: Array.from({ length: 14 }, () => []), players: ps, seed: 3, objective: H2H_PARAMS, candidates: ps.slice(0, 25).map((p) => p.id) });
    const ms = performance.now() - t0;
    expect(Object.keys(a.candidates).length).toBeGreaterThanOrEqual(20);
    expect(ms).toBeLessThan(1500); // target < 300 ms on a normal machine; the margin keeps loaded CI machines green
  });
});
void statsInto;
