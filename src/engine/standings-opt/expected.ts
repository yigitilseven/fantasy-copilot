import type { OpponentModelParams } from "@/types";
import { ROTO_CATEGORIES, type RotoCategory } from "../evaluation/standings";
import { createRng } from "../draft/rng";
import { NF, OPT_VIEWS, VIEW_COUNT, type OptView } from "./lines";
import { NCAT, makeScratch, rotoView, statsInto } from "./rank";
import { objectiveOf, type ObjectiveParams } from "./objective";
import { CORE_P, PUNT_P, catWinInto, weekStatsInto, winAtLeast } from "./h2h";
import { phi } from "./phi";

/**
 * Expected final standings and candidate evaluation (Monte Carlo over draft completions; pure, seeded, deterministic).
 *
 * MODEL. From the current state (picks made so far = current rosters), every remaining pick of every team is simulated R times
 * ("completions"):
 *  - OPPONENTS follow the same model as the survival simulator (engine/draft/simulator.ts): per completion each undrafted player gets a
 *    sampled draft position adp + k·sd·N(0,1) − 0.01·value (k and autopickShare from the fitted opponent model when enabled) and every
 *    opponent pick takes the lowest-key player still available (with probability autopickShare simply the best remaining ADP).
 *    Positional need is ignored (as in the survival simulator).
 *  - THE USER's future picks are greedy under a cheap SURROGATE of the objective: among the next `greedyWindow` (10) undrafted players by
 *    ADP he takes the one maximizing Σ_v w_v · value_v, where for the roto kinds value_v = Σ_c Φ((x_c − μ_c)/σ_c) (expected rank points,
 *    μ/σ the opponents' category totals calibrated on a few completions) and for the h2h kind value_v = P(>= 5 category wins) + 0.05 Σ_c q_c
 *    against the average opponent (q_c = Φ(Δ/ sqrt(σ_between² + 2 σ_week²)), weekly means/sds from h2h.ts). So the user's future picks fill his
 *    weakest categories instead of following ADP blindly, and a deficit in PTS gets repaired later in the draft (the baseline already
 *    "knows" it will happen). Positions/roster slots are NOT modelled (documented limit).
 *  - The final evaluation of every completion is EXACT: the Yahoo roto evaluator (ties averaged, TO lower is better) on all N complete
 *    rosters, in each of the three views.
 *
 * CANDIDATE c = "the user takes c with his next pick": c is credited to the user and removed from the opponents' pool (conditional on
 * getting him; survival is handled by the recommendation layer), the user's later picks stay greedy. All candidates and the baseline
 * share the same random draws (common random numbers), so differences between candidates are far less noisy than the values themselves.
 *
 * BASELINE = the same completions with the user's next pick also greedy: the "projected finish" shown in the UI, and the reference for the
 * per-candidate deltas ("+3.0 PTS rank pts in proj").
 */

export interface RotoPlayerInput {
  id: string;
  adp: number;
  adpSd: number;
  /** Raw 9-cat value (mild tiebreaker in the opponent key, as in the survival simulator). */
  value: number;
  /** viewLinesOf(record). */
  lines: Float64Array;
}

export interface RotoInput {
  teams: number;
  rounds: number;
  userSlot: number;
  /** Pick on the clock (1-based); teams*rounds+1 when the draft is over. */
  currentPick: number;
  /** Players drafted so far per team, index = slot - 1. */
  rosters: string[][];
  /** The whole universe (drafted players too: their lines are needed). */
  players: RotoPlayerInput[];
  model?: OpponentModelParams;
  seed: number;
  /** Completions (default 120). */
  sims?: number;
  objective: ObjectiveParams;
  /** Candidate player ids to evaluate (in addition to the automatic ones). */
  candidates?: string[];
  /** Automatic candidates: top-N undrafted by ADP and top-N by the surrogate gain at the current roster (defaults 10 / 10). */
  autoByAdp?: number;
  autoBySurrogate?: number;
  /** Players the user's greedy rollout picks choose among (next-N undrafted by ADP). Default 10. */
  greedyWindow?: number;
}

export interface ViewFinish {
  /** H2H: average weekly matchup win probability vs the 13 opponents, expected categories won per week, opponents beaten (P > 0.5). */
  winProb: number;
  catsWon: number;
  beats: number;
  /** Average P(win) per category vs the opponents. */
  catP: Record<RotoCategory, number>;
  /** Mean roto points (0..9N) and rank over the completions; rankMedian is the integer shown in the UI. */
  points: number;
  rank: number;
  rankMedian: number;
  /** P(rank <= topK). */
  pTop5: number;
  /** Mean rank points per category (1..N). */
  cats: Record<RotoCategory, number>;
}
export interface FinishProjection {
  views: Record<OptView, ViewFinish>;
  /** The view with the worst median roto rank (ties: lower points). */
  weakest: OptView;
  /** H2H summary over the views: mean win probability, categories won per week, opponents beaten, categories with P >= 0.6 (core) / < 0.3 (hopeless). */
  h2h: { winProb: number; minWinProb: number; catsWon: number; beats: number; catP: Record<RotoCategory, number>; core: RotoCategory[]; punted: RotoCategory[] };
  /** Mean objective value J. */
  objective: number;
}
export interface CandidateView {
  points: number;
  rank: number;
  rankMedian: number;
  pTop5: number;
  /** Differences vs the baseline (candidate − baseline): points, mean rank (negative = better) and per-category rank points. */
  dPoints: number;
  dRank: number;
  dCats: Record<RotoCategory, number>;
  /** H2H: win probability and the change vs the baseline, and the change of P(win) per category. */
  winProb: number;
  dWinProb: number;
  dCatP: Record<RotoCategory, number>;
}
export interface CandidateResult {
  playerId: string;
  objective: number;
  /** objective − baseline objective. */
  gain: number;
  /** Mean H2H win probability over the views, and the change vs the baseline. */
  winProb: number;
  dWinProb: number;
  /** Categories (mean over views) with the largest P(win) increase, best first. */
  moves: RotoCategory[];
  views: Record<OptView, CandidateView>;
}
export interface RotoAnalysis {
  sims: number;
  remainingPicks: number;
  userPicksLeft: number;
  baseline: FinishProjection;
  candidates: Record<string, CandidateResult>;
  objective: ObjectiveParams;
  topK: number;
  elapsedMs: number;
}

const BUFFER = 60;
const VALUE_EPS = 0.01;
export const DEFAULT_SIMS = 120;

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const emptyCats = (): Record<RotoCategory, number> => Object.fromEntries(ROTO_CATEGORIES.map((c) => [c, 0])) as Record<RotoCategory, number>;

interface Acc {
  n: number;
  pts: Float64Array; // per view
  cats: Float64Array; // view * NCAT
  hist: Int32Array; // view * (teams + 1) + rank
  obj: number;
  win: Float64Array; // per view
  catsWon: Float64Array; // per view
  beats: Float64Array; // per view
  catP: Float64Array; // view * NCAT
}

export function analyzeRoto(input: RotoInput): RotoAnalysis {
  const t0 = nowMs();
  const { teams, rounds, userSlot, currentPick, players, objective } = input;
  const user = userSlot - 1;
  const totalPicks = teams * rounds;
  const P = players.length;
  const stride = VIEW_COUNT * NF;
  const topK = objective.topK;

  const idx = new Map<string, number>();
  players.forEach((p, i) => idx.set(p.id, i));
  const L = new Float64Array(P * stride);
  players.forEach((p, i) => L.set(p.lines, i * stride));

  const taken0 = new Uint8Array(P);
  const T0 = new Float64Array(teams * stride);
  input.rosters.forEach((ids, t) => {
    if (t >= teams) return;
    for (const id of ids) {
      const i = idx.get(id);
      if (i === undefined) continue;
      taken0[i] = 1;
      for (let k = 0; k < stride; k++) T0[t * stride + k] += L[i * stride + k];
    }
  });

  const M = Math.max(0, totalPicks - currentPick + 1);
  const owners = new Int16Array(M);
  const userQs: number[] = [];
  for (let q = currentPick, j = 0; q <= totalPicks; q++, j++) {
    const round = Math.floor((q - 1) / teams) + 1;
    const i = (q - 1) % teams;
    owners[j] = round % 2 === 1 ? i : teams - 1 - i;
    if (owners[j] === user) userQs.push(j);
  }

  const model = input.model;
  const kMul = model && model.k > 0 ? model.k : 1;
  const autoShare = model ? Math.min(1, Math.max(0, model.autopickShare)) : 0;
  const R = M === 0 ? 1 : Math.max(1, Math.floor(input.sims ?? DEFAULT_SIMS));
  const G = Math.max(1, Math.floor(input.greedyWindow ?? 10));

  // ---- candidate pool for opponents: undrafted by ADP; later ones survive with probability 1 (as in the survival simulator)
  const und: number[] = [];
  for (let i = 0; i < P; i++) if (!taken0[i]) und.push(i);
  und.sort((a, b) => players[a].adp - players[b].adp || (a < b ? -1 : 1));
  const candIdx: number[] = [];
  for (let i = 0; i < und.length; i++) {
    const p = players[und[i]];
    if (i < M + BUFFER || p.adp - 3 * kMul * p.adpSd <= totalPicks) candIdx.push(und[i]);
  }
  const K = candIdx.length;
  const byAdp = Int32Array.from(candIdx);

  // ---- per-completion opponent orders (sampled keys)
  const orders: Int32Array[] = [];
  const autoU = autoShare > 0 ? new Float32Array(R * Math.max(1, M)) : null;
  if (M > 0) {
    const rng = createRng(input.seed >>> 0);
    const key = new Float64Array(K);
    for (let r = 0; r < R; r++) {
      for (let i = 0; i < K; i++) {
        const p = players[byAdp[i]];
        key[i] = p.adp + kMul * p.adpSd * rng.normal() - VALUE_EPS * p.value;
      }
      const ord = Array.from({ length: K }, (_, i) => i).sort((a, b) => key[a] - key[b] || a - b);
      orders.push(Int32Array.from(ord, (i) => byAdp[i]));
      if (autoU) for (let j = 0; j < M; j++) autoU[r * M + j] = rng.next();
    }
  }

  // ---- state shared by the walks
  const taken = new Uint8Array(P);
  const T = new Float64Array(teams * stride);
  const scratch = makeScratch(teams);
  const tmp = new Float64Array(stride);
  const stats = new Float64Array(NCAT);
  const mu = new Float64Array(VIEW_COUNT * NCAT);
  const sg = new Float64Array(VIEW_COUNT * NCAT).fill(1);
  const V0 = new Float64Array(VIEW_COUNT);
  const w = objective.weights;
  const h2hKind = objective.kind === "h2h";
  // h2h surrogate: opponents' average weekly means and the denominator sqrt(sd_between² + 2·sd_week²)
  const omean = new Float64Array(VIEW_COUNT * NCAT);
  const oden = new Float64Array(VIEW_COUNT * NCAT).fill(1);
  const wm = new Float64Array(NCAT);
  const wsd = new Float64Array(NCAT);
  const q = new Float64Array(NCAT);

  /** Surrogate value of the packed total at `off` of `src` in view `view` (see module doc). */
  const valueOf = (src: Float64Array, off: number, view: number): number => {
    if (!h2hKind) {
      statsInto(src, off, stats, 0);
      let s = 0;
      for (let c = 0; c < NCAT; c++) {
        const z = (stats[c] - mu[view * NCAT + c]) / sg[view * NCAT + c];
        s += phi(c === NCAT - 1 ? -z : z);
      }
      return s;
    }
    weekStatsInto(src, off, view, wm, wsd, 0);
    let sum = 0;
    for (let c = 0; c < NCAT; c++) {
      const z = (wm[c] - omean[view * NCAT + c]) / oden[view * NCAT + c];
      q[c] = phi(c === NCAT - 1 ? -z : z);
      sum += q[c];
    }
    return winAtLeast(q, 0) + 0.05 * sum;
  };
  const refreshS0 = (): void => {
    for (let v = 0; v < VIEW_COUNT; v++) V0[v] = valueOf(T, (user * VIEW_COUNT + v) * NF, v);
  };
  /** Surrogate gain of adding player p to the user's current totals T (refreshS0 first). */
  const gainOf = (p: number): number => {
    let g = 0;
    for (let v = 0; v < VIEW_COUNT; v++) {
      const base = (user * VIEW_COUNT + v) * NF;
      for (let f = 0; f < NF; f++) tmp[f] = T[base + f] + L[p * stride + v * NF + f];
      g += w[v] * (valueOf(tmp, 0, v) - V0[v]);
    }
    return g;
  };

  /** Runs completion r; the user's `forced` player (or -1) takes his first remaining pick. policy 0 = best ADP, 1 = surrogate-greedy. */
  const walk = (r: number, forced: number, policy: 0 | 1): void => {
    taken.set(taken0);
    T.set(T0);
    if (forced >= 0) taken[forced] = 1;
    let pending = forced >= 0;
    const ord = orders[r];
    let ptr = 0;
    let adpPtr = 0;
    for (let j = 0; j < M; j++) {
      const slot = owners[j];
      let p = -1;
      if (slot === user) {
        if (pending) {
          p = forced;
          pending = false;
        } else {
          while (adpPtr < K && taken[byAdp[adpPtr]]) adpPtr++;
          if (policy === 0 || adpPtr >= K) p = adpPtr < K ? byAdp[adpPtr] : -1;
          else {
            refreshS0();
            let best = -Infinity;
            let seen = 0;
            for (let a = adpPtr; a < K && seen < G; a++) {
              const q = byAdp[a];
              if (taken[q]) continue;
              seen++;
              const g = gainOf(q);
              if (g > best) {
                best = g;
                p = q;
              }
            }
          }
          if (p >= 0) taken[p] = 1;
        }
      } else {
        if (autoU && autoU[r * M + j] < autoShare) {
          while (adpPtr < K && taken[byAdp[adpPtr]]) adpPtr++;
          p = adpPtr < K ? byAdp[adpPtr] : -1;
        } else {
          while (ptr < K && taken[ord[ptr]]) ptr++;
          p = ptr < K ? ord[ptr] : -1;
        }
        if (p >= 0) taken[p] = 1;
      }
      if (p < 0) continue;
      const base = slot * stride;
      for (let k = 0; k < stride; k++) T[base + k] += L[p * stride + k];
    }
  };

  const ranks = new Float64Array(VIEW_COUNT);
  const pts = new Float64Array(VIEW_COUNT);
  const wins = new Float64Array(VIEW_COUNT);
  const wMean = new Float64Array(teams * VIEW_COUNT * NCAT);
  const wSd = new Float64Array(teams * VIEW_COUNT * NCAT);
  const pc = new Float64Array(NCAT);
  const newAcc = (): Acc => ({
    n: 0, pts: new Float64Array(VIEW_COUNT), cats: new Float64Array(VIEW_COUNT * NCAT), hist: new Int32Array(VIEW_COUNT * (teams + 1)), obj: 0,
    win: new Float64Array(VIEW_COUNT), catsWon: new Float64Array(VIEW_COUNT), beats: new Float64Array(VIEW_COUNT), catP: new Float64Array(VIEW_COUNT * NCAT),
  });
  const accumulate = (acc: Acc): void => {
    for (let t = 0; t < teams; t++)
      for (let v = 0; v < VIEW_COUNT; v++) weekStatsInto(T, (t * VIEW_COUNT + v) * NF, v, wMean, wSd, (t * VIEW_COUNT + v) * NCAT);
    for (let v = 0; v < VIEW_COUNT; v++) {
      ranks[v] = rotoView(T, teams, v, user, scratch);
      pts[v] = scratch.total[user];
      acc.pts[v] += pts[v];
      for (let c = 0; c < NCAT; c++) acc.cats[v * NCAT + c] += scratch.points[user * NCAT + c];
      acc.hist[v * (teams + 1) + ranks[v]]++;
      let win = 0, cats = 0, beats = 0;
      for (let j = 0; j < teams; j++) {
        if (j === user) continue;
        catWinInto(wMean, wSd, (user * VIEW_COUNT + v) * NCAT, wMean, wSd, (j * VIEW_COUNT + v) * NCAT, pc, 0);
        const pw = winAtLeast(pc, 0);
        win += pw;
        if (pw > 0.5) beats++;
        for (let c = 0; c < NCAT; c++) {
          cats += pc[c];
          acc.catP[v * NCAT + c] += pc[c] / (teams - 1);
        }
      }
      wins[v] = teams > 1 ? win / (teams - 1) : 0;
      acc.win[v] += wins[v];
      acc.catsWon[v] += teams > 1 ? cats / (teams - 1) : 0;
      acc.beats[v] += beats;
    }
    acc.obj += objectiveOf(pts, ranks, wins, objective);
    acc.n++;
  };
  const runSet = (forced: number): Acc => {
    const acc = newAcc();
    for (let r = 0; r < R; r++) {
      if (M > 0) walk(r, forced, 1);
      else T.set(T0);
      accumulate(acc);
    }
    return acc;
  };

  // ---- calibrate the surrogate on opponents' final totals (a few completions, ADP-greedy user)
  if (M > 0) {
    const R0 = Math.min(R, 24);
    const sum = new Float64Array(VIEW_COUNT * NCAT);
    const sq = new Float64Array(VIEW_COUNT * NCAT);
    const wsum = new Float64Array(VIEW_COUNT * NCAT);
    const wsq = new Float64Array(VIEW_COUNT * NCAT);
    const wsdSum = new Float64Array(VIEW_COUNT * NCAT);
    let n = 0;
    for (let r = 0; r < R0; r++) {
      walk(r, -1, 0);
      for (let t = 0; t < teams; t++) {
        if (t === user) continue;
        n++;
        for (let v = 0; v < VIEW_COUNT; v++) {
          statsInto(T, (t * VIEW_COUNT + v) * NF, stats, 0);
          weekStatsInto(T, (t * VIEW_COUNT + v) * NF, v, wm, wsd, 0);
          for (let c = 0; c < NCAT; c++) {
            sum[v * NCAT + c] += stats[c];
            sq[v * NCAT + c] += stats[c] * stats[c];
            wsum[v * NCAT + c] += wm[c];
            wsq[v * NCAT + c] += wm[c] * wm[c];
            wsdSum[v * NCAT + c] += wsd[c];
          }
        }
      }
    }
    const nn = Math.max(1, n);
    for (let k = 0; k < VIEW_COUNT * NCAT; k++) {
      mu[k] = sum[k] / nn;
      sg[k] = Math.max(1e-9, Math.sqrt(Math.max(0, sq[k] / nn - mu[k] * mu[k])));
      omean[k] = wsum[k] / nn;
      const sb2 = Math.max(0, wsq[k] / nn - omean[k] * omean[k]);
      const sw = wsdSum[k] / nn;
      oden[k] = Math.max(1e-9, Math.sqrt(sb2 + 2 * sw * sw));
    }
  }

  // ---- baseline
  const baseAcc = runSet(-1);
  const finishOf = (acc: Acc) => {
    const views = {} as Record<OptView, ViewFinish>;
    let weakest: OptView = OPT_VIEWS[0];
    let weakMed = -1;
    let weakPts = Infinity;
    OPT_VIEWS.forEach((view, v) => {
      let cum = 0;
      let med = teams;
      let meanRank = 0;
      let top = 0;
      let found = false;
      for (let rk = 1; rk <= teams; rk++) {
        const c = acc.hist[v * (teams + 1) + rk];
        meanRank += rk * c;
        if (rk <= topK) top += c;
        cum += c;
        if (!found && cum * 2 >= acc.n) {
          med = rk;
          found = true;
        }
      }
      const cats = emptyCats();
      ROTO_CATEGORIES.forEach((cat, c) => (cats[cat] = acc.cats[v * NCAT + c] / acc.n));
      const catP = emptyCats();
      ROTO_CATEGORIES.forEach((cat, c) => (catP[cat] = acc.catP[v * NCAT + c] / acc.n));
      views[view] = { winProb: acc.win[v] / acc.n, catsWon: acc.catsWon[v] / acc.n, beats: acc.beats[v] / acc.n, catP, points: acc.pts[v] / acc.n, rank: meanRank / acc.n, rankMedian: med, pTop5: top / acc.n, cats };
      if (med > weakMed || (med === weakMed && views[view].points < weakPts)) {
        weakest = view;
        weakMed = med;
        weakPts = views[view].points;
      }
    });
    const mean = (f: (x: ViewFinish) => number) => OPT_VIEWS.reduce((a, view) => a + f(views[view]), 0) / OPT_VIEWS.length;
    const catP = emptyCats();
    for (const cat of ROTO_CATEGORIES) catP[cat] = mean((x) => x.catP[cat]);
    const h2h = {
      winProb: mean((x) => x.winProb),
      minWinProb: Math.min(...OPT_VIEWS.map((view) => views[view].winProb)),
      catsWon: mean((x) => x.catsWon),
      beats: mean((x) => x.beats),
      catP,
      core: ROTO_CATEGORIES.filter((c) => catP[c] >= CORE_P),
      punted: ROTO_CATEGORIES.filter((c) => catP[c] < PUNT_P),
    };
    return { views, weakest, h2h, objective: acc.obj / acc.n } satisfies FinishProjection;
  };
  const baseline = finishOf(baseAcc);

  // ---- candidates
  const candidates: Record<string, CandidateResult> = {};
  if (M > 0 && userQs.length > 0) {
    const ids = new Set<string>();
    for (const id of input.candidates ?? []) {
      const i = idx.get(id);
      if (i !== undefined && !taken0[i]) ids.add(id);
    }
    for (let a = 0, n = 0; a < und.length && n < (input.autoByAdp ?? 10); a++, n++) ids.add(players[und[a]].id);
    const nSur = input.autoBySurrogate ?? 10;
    if (nSur > 0) {
      T.set(T0);
      refreshS0();
      const scored = und.slice(0, Math.min(und.length, M + BUFFER)).map((i) => ({ i, g: gainOf(i) }));
      scored.sort((a, b) => b.g - a.g || a.i - b.i);
      for (let a = 0; a < nSur && a < scored.length; a++) ids.add(players[scored[a].i].id);
    }
    for (const id of ids) {
      const i = idx.get(id)!;
      const acc = runSet(i);
      const f = finishOf(acc);
      const views = {} as Record<OptView, CandidateView>;
      for (const view of OPT_VIEWS) {
        const b = baseline.views[view];
        const x = f.views[view];
        const dCats = emptyCats();
        for (const cat of ROTO_CATEGORIES) dCats[cat] = x.cats[cat] - b.cats[cat];
        const dCatP = emptyCats();
        for (const cat of ROTO_CATEGORIES) dCatP[cat] = x.catP[cat] - b.catP[cat];
        views[view] = { points: x.points, rank: x.rank, rankMedian: x.rankMedian, pTop5: x.pTop5, dPoints: x.points - b.points, dRank: x.rank - b.rank, dCats, winProb: x.winProb, dWinProb: x.winProb - b.winProb, dCatP };
      }
      const moves = ROTO_CATEGORIES.map((cat) => ({ cat, d: f.h2h.catP[cat] - baseline.h2h.catP[cat] })).filter((m) => m.d > 0.005).sort((a, b) => b.d - a.d).map((m) => m.cat);
      candidates[id] = { playerId: id, objective: f.objective, gain: f.objective - baseline.objective, winProb: f.h2h.winProb, dWinProb: f.h2h.winProb - baseline.h2h.winProb, moves, views };
    }
  }

  return { sims: R, remainingPicks: M, userPicksLeft: userQs.length, baseline, candidates, objective, topK, elapsedMs: nowMs() - t0 };
}
