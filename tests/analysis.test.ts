import { describe, expect, it } from "vitest";
import {
  PLAYER_MAP, bestKWithin, biggestReachesSteals, brier, buildObservations, calibrateDraft, detectAutopicks, deviationByRound, fitOpponentModel,
  managerStats, pickDeviations, positionalRuns, reliability, type AnalysisDraft, type AnalysisPlayer,
} from "@/engine/analysis";
import { pickForOpponent } from "@/engine/draft/opponent";
import { createRng } from "@/engine/draft/rng";
import { pickOwner } from "@/engine/draft/snake";
import { simulateSurvival } from "@/engine/draft/simulator";
import { simSeed } from "@/store/derived";
import type { Position, SimPlayer } from "@/types";

const POS: Position[][] = [["PG"], ["SG"], ["SF"], ["PF"], ["C"], ["PG", "SG"], ["SF", "PF"]];
function mkPlayers(n: number): AnalysisPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, name: `Player ${i + 1}`, positions: POS[i % POS.length], adp: i + 1, adpStdDev: Math.min(22, 0.8 + 0.12 * (i + 1)), rank: i + 1, value: 10 - i / 30,
  }));
}
const sim = (ps: AnalysisPlayer[]): SimPlayer[] => ps.map((p) => ({ id: p.id, adp: p.adp, adpStdDev: p.adpStdDev, value: p.value, positions: p.positions }));

/** A draft whose picks follow `order` (player ids) exactly. */
function draftOf(order: string[], teams = 4, rounds = 5, userSlot = 2, id = 1): AnalysisDraft {
  return {
    id, teams, rounds, userSlot, teamNames: { 1: "Alpha", 2: "Me", 3: "Gamma", 4: "Delta" },
    picks: order.map((playerId, i) => ({ pick: i + 1, ...pickOwner(i + 1, teams), playerId })),
  };
}

describe("reach / fall", () => {
  const players = mkPlayers(30);
  const map = PLAYER_MAP(players);
  // chalk for 8 picks, then p20 at pick 9 (reach of -11) and p9 at pick 10 (fall of +1)
  const d = draftOf(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p20", "p9"]);
  it("deviation = pick - ADP; reaches negative, steals positive", () => {
    const devs = pickDeviations([d], map);
    expect(devs).toHaveLength(10);
    expect(devs[8]).toMatchObject({ pick: 9, adp: 20, deviation: -11, teamName: "Alpha" });
    expect(devs[9].deviation).toBe(1);
    const { reaches, steals } = biggestReachesSteals(devs, 1);
    expect(reaches[0].playerId).toBe("p20");
    expect(steals[0].playerId).toBe("p9");
  });
  it("uses the ADP recorded at pick time when present", () => {
    const withCtx = { ...d, picks: d.picks.map((p) => (p.pick === 9 ? { ...p, adpAtPick: 9 } : p)) };
    expect(pickDeviations([withCtx], map)[8].deviation).toBe(0);
  });
  it("per-round mean / sd / within-sigma", () => {
    const rows = deviationByRound(pickDeviations([d], map));
    expect(rows.map((r) => [r.round, r.n])).toEqual([[1, 4], [2, 4], [3, 2]]);
    expect(rows[0]).toMatchObject({ mean: 0, sd: 0, withinSigma: 1 });
    const r3 = rows[2];
    expect(r3.mean).toBeCloseTo(-5, 10); // (-11 + 1) / 2
    expect(r3.sd).toBeCloseTo(Math.sqrt(72), 10);
    expect(r3.withinSigma).toBe(0.5); // |+1| <= sigma(p9) = 1.88; |-11| > sigma(p20) = 3.2
  });
  it("placeholders and out-of-market players are ignored", () => {
    const ps = [...players, { ...players[0], id: "yahoo-x", adp: 999 }];
    const dd = draftOf(["yahoo-x", "p1"]);
    expect(pickDeviations([dd], PLAYER_MAP(ps))).toHaveLength(1);
  });
});

describe("positional runs", () => {
  const players = mkPlayers(30);
  const map = PLAYER_MAP(players);
  it("flags windows with >= 3 of 5 sharing a position and merges overlaps into one run", () => {
    // ids p5, p12 are C; p2 (SG), p1 (PG) etc. Build picks: C C x C x x x x
    const C = players.filter((p) => p.positions.length === 1 && p.positions[0] === "C").map((p) => p.id);
    const PG = players.filter((p) => p.positions.length === 1 && p.positions[0] === "PG").map((p) => p.id);
    const SG = players.filter((p) => p.positions.length === 1 && p.positions[0] === "SG").map((p) => p.id);
    const order = [C[0], C[1], PG[0], C[2], SG[0], PG[1], SG[1], PG[2]];
    const r = positionalRuns(draftOf(order), map);
    expect(r.windows).toBe(4);
    expect(r.flagged).toBeGreaterThanOrEqual(1);
    expect(r.runs[0]).toMatchObject({ position: "C", startPick: 1, count: 3 });
    expect(r.runs.filter((x) => x.position === "C")).toHaveLength(1);
    expect(r.byRound[0]).toMatchObject({ round: 1 });
  });
  it("a window of five different positions is not a run", () => {
    const one = (pos: Position) => players.find((p) => p.positions.length === 1 && p.positions[0] === pos)!.id;
    const r = positionalRuns(draftOf([one("PG"), one("SG"), one("SF"), one("PF"), one("C")]), map);
    expect(r.windows).toBe(1);
    expect(r.flagged).toBe(0);
  });
});

describe("autopick detection", () => {
  const players = mkPlayers(40);
  const map = PLAYER_MAP(players);
  it("chalk picks match the best available by ADP; reaches do not; share per team", () => {
    // team slots (4 teams, snake): picks 1..8 = slots 1,2,3,4,4,3,2,1
    const d = draftOf(["p1", "p2", "p3", "p10", "p4", "p5", "p6", "p7"]);
    const a = detectAutopicks(d, map);
    expect(a.byPick.map((b) => b.adpTop)).toEqual([true, true, true, false, true, true, true, true]);
    const delta = a.byTeam.find((t) => t.teamName === "Delta")!;
    expect(delta).toMatchObject({ picks: 2, adpTop: 1, share: 0.5 });
    const alpha = a.byTeam.find((t) => t.teamName === "Alpha")!;
    expect(alpha.share).toBe(1);
    expect(a.byTeam.find((t) => t.isUser)!.teamName).toBe("Me");
  });
  it("flags only teams with enough picks above the threshold", () => {
    const order = Array.from({ length: 20 }, (_, i) => `p${i + 1}`);
    const a = detectAutopicks(draftOf(order, 4, 5), map);
    expect(a.byTeam.every((t) => t.flagged)).toBe(true); // pure chalk
  });
});

describe("managers", () => {
  it("aggregates by team name across drafts", () => {
    const players = mkPlayers(40);
    const map = PLAYER_MAP(players);
    const stats = managerStats([draftOf(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], 4, 5, 2, 1), draftOf(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"], 4, 5, 2, 2)], map);
    const alpha = stats.find((s) => s.name === "Alpha")!;
    expect(alpha).toMatchObject({ drafts: 2, picks: 4 });
    expect(alpha.autopickShare).toBe(1);
    expect(alpha.positions.PG).toBeGreaterThan(0);
    expect(alpha.avgDeviation).toBeCloseTo(0, 10);
  });
});

describe("survival calibration replay", () => {
  const players = mkPlayers(120);
  const pool = sim(players);
  // 6 teams x 6 rounds, user slot 3; chalk draft
  const teams = 6;
  const rounds = 6;
  const d = draftOf(Array.from({ length: teams * rounds }, (_, i) => `p${i + 1}`), teams, rounds, 3, 9);

  it("is deterministic (same state + same seed) and predicts high survival for deep players", () => {
    const a = calibrateDraft(d, pool, { simulations: 800 });
    const b = calibrateDraft(d, pool, { simulations: 800 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((p) => p.predicted >= 0 && p.predicted <= 1)).toBe(true);
    // the first decision (pick 3, target 10): the player the user took (p3) is excluded; the sim state excludes only picks 1-2
    const first = a.filter((p) => p.decisionPick === 3);
    expect(first[0].targetPick).toBe(10);
    expect(first.find((p) => p.playerId === "p3")).toBeUndefined();
    // chalk draft: p4..p9 are all taken before pick 10 => observed 0, and p10+ remain
    expect(first.find((p) => p.playerId === "p4")!.observed).toBe(0);
    expect(first.find((p) => p.playerId === "p12")!.observed).toBe(1);
  });
  it("uses the app's seed derivation by default", () => {
    const custom = calibrateDraft(d, pool, { simulations: 500, seedFn: () => 1 });
    const def = calibrateDraft(d, pool, { simulations: 500, seedFn: simSeed });
    expect(calibrateDraft(d, pool, { simulations: 500 })).toEqual(def);
    expect(custom).not.toEqual(def);
  });
  it("skips decisions whose target window is not recorded (partial drafts)", () => {
    const partial = { ...d, picks: d.picks.slice(0, 12) };
    const pts = calibrateDraft(partial, pool, { simulations: 300 });
    expect(Math.max(...pts.map((p) => p.decisionPick))).toBeLessThanOrEqual(10);
    expect(pts.every((p) => p.targetPick - 1 <= 12)).toBe(true);
  });
  it("reliability buckets and Brier score", () => {
    const pts = [
      { predicted: 0.05, observed: 0 }, { predicted: 0.05, observed: 1 }, { predicted: 0.95, observed: 1 }, { predicted: 1, observed: 1 },
    ].map((p) => ({ ...p, draftId: 1, decisionPick: 1, targetPick: 2, playerId: "x", adp: 1, observed: p.observed as 0 | 1 }));
    const r = reliability(pts);
    expect(r).toHaveLength(10);
    expect(r[0]).toMatchObject({ n: 2, observedRate: 0.5 });
    expect(r[9]).toMatchObject({ n: 2, observedRate: 1 });
    expect(brier(pts)).toBeCloseTo((0.0025 + 0.9025 + 0.0025 + 0) / 4, 10);
    expect(brier([])).toBe(0);
  });
});

describe("opponent model parameters (simulator)", () => {
  const players = mkPlayers(120);
  const pool = sim(players);
  const base = { currentPick: 1, targetPick: 13, teams: 12, players: pool, simulations: 1500, seed: 7 };
  it("defaults are unchanged: no model, k=1/autopick=0 give identical results", () => {
    const a = simulateSurvival(base);
    expect(simulateSurvival({ ...base, model: { k: 1, autopickShare: 0 } }).survival).toEqual(a.survival);
  });
  it("larger k spreads survival (a top player survives more often, a deep player less)", () => {
    const a = simulateSurvival(base).survival;
    const b = simulateSurvival({ ...base, model: { k: 2.5, autopickShare: 0 } }).survival;
    expect(b.p11).toBeGreaterThan(a.p11);
    expect(b.p25).toBeLessThan(a.p25);
  });
  it("autopickShare = 1 is chalk: the best 12 by ADP are gone, the rest survive", () => {
    const s = simulateSurvival({ ...base, model: { k: 1, autopickShare: 1 } }).survival;
    for (let i = 1; i <= 12; i++) expect(s[`p${i}`]).toBe(0);
    expect(s.p13).toBe(1);
  });
  it("pickForOpponent honours the model too", () => {
    const rng = createRng(3);
    expect(pickForOpponent(pool, rng, { model: { k: 1, autopickShare: 1 } })).toBe("p1");
  });
});

describe("model fitting", () => {
  /** Sample a draft with the opponent model at a known k (what the fit should recover). */
  function synth(k: number, seed: number, id: number): AnalysisDraft {
    const players = mkPlayers(260);
    const pool = sim(players);
    const rng = createRng(seed);
    const taken = new Set<string>();
    const teams = 14;
    const rounds = 13;
    const picks: AnalysisDraft["picks"] = [];
    for (let pick = 1; pick <= teams * rounds; pick++) {
      const id2 = pickForOpponent(pool.filter((p) => !taken.has(p.id)), rng, { model: { k, autopickShare: 0 } })!;
      taken.add(id2);
      picks.push({ pick, ...pickOwner(pick, teams), playerId: id2 });
    }
    return { id, teams, rounds, userSlot: 13, teamNames: {}, picks };
  }
  it("recovers a known k from a synthetic draft", () => {
    const pool = sim(mkPlayers(260));
    const obs = [synth(1.8, 11, 1), synth(1.8, 12, 2)].flatMap((d) => buildObservations(d, pool));
    expect(obs.length).toBeGreaterThan(300);
    const fit = fitOpponentModel(obs, { ks: [0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 3], samples: 400 });
    expect(fit.k).toBeGreaterThanOrEqual(1.5);
    expect(fit.k).toBeLessThanOrEqual(2.1);
    expect(fit.autopickShare).toBeLessThanOrEqual(0.1);
    expect(fit.logLik).toBeGreaterThan(fit.logLikDefault);
    expect(bestKWithin(fit, 0.5, 1.2).k).toBeLessThanOrEqual(1.2);
  });
  it("detects an autopick mixture", () => {
    const players = mkPlayers(260);
    const pool = sim(players);
    const rng = createRng(5);
    const taken = new Set<string>();
    const picks: AnalysisDraft["picks"] = [];
    for (let pick = 1; pick <= 182; pick++) {
      const avail = pool.filter((p) => !taken.has(p.id));
      const id = pickForOpponent(avail, rng, { model: { k: 1, autopickShare: 0.5 } })!;
      taken.add(id);
      picks.push({ pick, ...pickOwner(pick, 14), playerId: id });
    }
    const fit = fitOpponentModel(buildObservations({ id: 1, teams: 14, rounds: 13, userSlot: 13, teamNames: {}, picks }, pool), { ks: [0.8, 1, 1.2, 1.5], samples: 300 });
    expect(fit.autopickShare).toBeGreaterThanOrEqual(0.3);
    expect(fit.autopickShare).toBeLessThanOrEqual(0.65);
  });
});
