import type { Category, PlayerRecord, ProjectionLine } from "@/types";
import { CATEGORIES } from "@/types";
import { computeValuations } from "../valuation/value";

/**
 * Pure math of the blend backtest (scripts/blend-backtest.ts): how well does last season's production predict the next season's,
 * per player group, separately for RATES (per-36 production) and VOLUME (games, minutes per game)?
 *
 * "Trust" translation (see `calibrate`): for a group g let s_g^2 be its mean squared prediction error (from ONE pooled
 * regression next = a + b*prev fitted on all players) relative to the variance of the next-season values. Assume the forward
 * projection (Yahoo) has error s_Y^2 = kappa * s_pool^2. Inverse-variance weighting then gives the real-stats weight
 *   w_real(g) = s_Y^2 / (s_Y^2 + s_g^2),   Yahoo weight = 1 - w_real(g).
 * Yahoo's own accuracy cannot be measured offline, so kappa is NOT estimated: it fixes the overall LEVEL (anchored to the agreed
 * 0.6 default for "everyone else"); the evidence only decides how groups differ from each other.
 */

export interface SeasonRow {
  id: string;
  name: string;
  team: string | null;
  /** Age in that season (NBA.com convention). */
  age: number | null;
  line: ProjectionLine;
}

export interface PairRow {
  id: string;
  name: string;
  prev: SeasonRow;
  next: SeasonRow;
}

/** NBA.com fantasy points formula; a single "production" scalar per game used to rank/pool players and to scale minutes. */
export function production(l: Pick<ProjectionLine, "pts" | "reb" | "ast" | "stl" | "blk" | "tov">): number {
  return l.pts + 1.2 * l.reb + 1.5 * l.ast + 3 * l.stl + 3 * l.blk - l.tov;
}

const RATE_FIELDS = ["pts", "fgm", "fga", "ftm", "fta", "threePm", "reb", "ast", "stl", "blk", "tov"] as const;

/** Per-36-minute version of a line (games kept, minutes = 36). */
export function per36Line(l: ProjectionLine): ProjectionLine {
  const k = l.minutes > 0 ? 36 / l.minutes : 0;
  const out = { ...l, minutes: 36 } as ProjectionLine;
  for (const f of RATE_FIELDS) out[f] = l[f] * k;
  return out;
}

export function pairSeasons(prev: SeasonRow[], next: SeasonRow[], minGp = 20): PairRow[] {
  const count = (rows: SeasonRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.id, (m.get(r.id) ?? 0) + 1);
    return m;
  };
  const cp = count(prev);
  const cn = count(next);
  const byId = new Map(prev.map((r) => [r.id, r]));
  const out: PairRow[] = [];
  for (const n of next) {
    const p = byId.get(n.id);
    if (!p || cp.get(n.id) !== 1 || cn.get(n.id) !== 1) continue;
    if (p.line.games < minGp || n.line.games < minGp || !(p.line.minutes > 0) || !(n.line.minutes > 0)) continue;
    out.push({ id: n.id, name: n.name, prev: p, next: n });
  }
  return out;
}

// ------------------------------------------------------------------ statistics

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs: number[]) => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

export interface Fit {
  n: number;
  a: number;
  b: number;
  r: number;
  r2: number;
  /** Variance of the y values. */
  varY: number;
}

export function ols(x: number[], y: number[]): Fit {
  const n = x.length;
  if (n < 3) return { n, a: mean(y), b: 0, r: 0, r2: 0, varY: variance(y) };
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  return { n, a: my - b * mx, b, r, r2: r * r, varY: syy / n };
}

/** sqrt(mean((x - y)^2)). */
export const rmse = (x: number[], y: number[]) => Math.sqrt(mean(x.map((v, i) => (v - y[i]) ** 2)));

// ------------------------------------------------------------------ metric extraction

export type Metric = Category | "MPG" | "GP" | "SUM_Z36" | "SUM_ZG";
/** What a pair gives for a metric: previous-season value and next-season value. */
export interface Samples {
  prev: number[];
  next: number[];
}

function pseudoRecords(lines: { id: string; line: ProjectionLine }[]): PlayerRecord[] {
  const ranked = [...lines].sort((a, b) => production(b.line) - production(a.line));
  return ranked.map(({ id, line }, i) => ({
    player: { id, yahooPlayerKey: null, name: id, nbaTeam: "", positions: ["SF"], age: 27 },
    projection: { playerId: id, ...line },
    market: { playerId: id, yahooAdp: i + 1, adpStdDev: 1, rank: i + 1 },
    risk: { playerId: id, projectedGames: line.games, currentStatus: "healthy", injuryHistoryScore: 0, restRisk: 0, availabilityScore: 1, majorInjuryHistory: false, updatedAt: "" },
  }));
}

export interface ZTable {
  /** Per-game 9-cat z vectors (and sums) of the whole season's league. */
  game: Record<string, { z: Record<Category, number>; sum: number }>;
  /** Per-36 9-cat z vectors. */
  rate: Record<string, { z: Record<Category, number>; sum: number }>;
}

/** z-values of every row of a season, per game and per 36 minutes, each standardized within that season's top-N pool. */
export function seasonZ(rows: SeasonRow[], poolSize = 182): ZTable {
  const pick = (lines: { id: string; line: ProjectionLine }[]) => {
    const v = computeValuations(pseudoRecords(lines), { poolSize }).valuations;
    return Object.fromEntries(Object.entries(v).map(([id, x]) => [id, { z: x.z as Record<Category, number>, sum: x.nineCat }]));
  };
  // The pool for both tables is the top-N by per-game production (so per-36 z are relative to the same set of real players).
  const ranked = [...rows].sort((a, b) => production(b.line) - production(a.line));
  const game = pick(ranked.map((r) => ({ id: r.id, line: r.line })));
  const rateRecords = pseudoRecords(ranked.map((r) => ({ id: r.id, line: per36Line(r.line) })));
  // pseudoRecords re-ranks by per-36 production; restore the per-game ranking so the pool is the same players.
  const byId = new Map(ranked.map((r, i) => [r.id, i + 1]));
  for (const rec of rateRecords) rec.market = { ...rec.market, rank: byId.get(rec.player.id)! };
  const rv = computeValuations(rateRecords, { poolSize }).valuations;
  const rate = Object.fromEntries(Object.entries(rv).map(([id, x]) => [id, { z: x.z as Record<Category, number>, sum: x.nineCat }]));
  return { game, rate };
}

export interface PairData {
  pair: PairRow;
  zPrev: ZTable;
  zNext: ZTable;
}

export function metricSamples(pairs: PairRow[], zPrev: ZTable, zNext: ZTable, metric: Metric): Samples {
  const prev: number[] = [];
  const next: number[] = [];
  for (const p of pairs) {
    const pz = zPrev.rate[p.id];
    const nz = zNext.rate[p.id];
    const pg = zPrev.game[p.id];
    const ng = zNext.game[p.id];
    switch (metric) {
      case "MPG": prev.push(p.prev.line.minutes); next.push(p.next.line.minutes); break;
      case "GP": prev.push(p.prev.line.games); next.push(p.next.line.games); break;
      case "SUM_Z36": if (pz && nz) { prev.push(pz.sum); next.push(nz.sum); } break;
      case "SUM_ZG": if (pg && ng) { prev.push(pg.sum); next.push(ng.sum); } break;
      default: if (pz && nz) { prev.push(pz.z[metric]); next.push(nz.z[metric]); }
    }
  }
  return { prev, next };
}

// ------------------------------------------------------------------ groups

export interface GroupDef {
  id: string;
  label: string;
  /** Inclusion test on a (prev, next) pair; uses the same predicates as playerBlendWeights where they exist. */
  test: (p: PairRow) => boolean;
}

const sameTeam = (p: PairRow) => !!p.prev.team && !!p.next.team && p.prev.team === p.next.team;
const ageOf = (p: PairRow) => p.next.age ?? NaN;

/** Groups mirror the production rules (age in the PREDICTED season; "stable" = last season GP >= 60 and no team change). */
export const GROUPS: GroupDef[] = [
  { id: "all", label: "All players (>=20 GP both seasons)", test: () => true },
  { id: "young", label: "Young: age <= 23", test: (p) => ageOf(p) <= 23 },
  { id: "stable", label: "Stable veterans: age 24-31, GP >= 60, same team", test: (p) => ageOf(p) >= 24 && ageOf(p) <= 31 && p.prev.line.games >= 60 && sameTeam(p) },
  { id: "age32", label: "Age 32+", test: (p) => ageOf(p) >= 32 },
  { id: "team", label: "Team changers", test: (p) => !!p.prev.team && !!p.next.team && p.prev.team !== p.next.team },
  { id: "injury", label: "Injury returners: previous GP < 40", test: (p) => p.prev.line.games < 40 },
  { id: "role", label: "Role changers (ex post: |dMPG| >= 5; look-ahead, informational)", test: (p) => Math.abs(p.next.line.minutes - p.prev.line.minutes) >= 5 },
  { id: "other", label: "Everyone else (24-31, not stable/team/injury)", test: (p) => ageOf(p) >= 24 && ageOf(p) <= 31 && !(p.prev.line.games >= 60 && sameTeam(p)) && sameTeam(p) && p.prev.line.games >= 40 },
];

// ------------------------------------------------------------------ backtest

export interface MetricStat {
  metric: Metric;
  n: number;
  r: number;
  r2: number;
  /** RMSE of the naive prediction next = prev, in units of the next-season SD. */
  nrmse: number;
  /** MSE of the POOLED regression's residuals on this group's players, relative to the pooled variance of next. */
  relMse: number;
}

export interface GroupResult {
  id: string;
  label: string;
  n: number;
  metrics: MetricStat[];
  /** Mean R^2 over the nine per-36 category z-values. */
  rateR2: number;
  /** Mean relMse over the nine categories (rate error in pooled-variance units). */
  rateRelMse: number;
  /** Mean of R^2(MPG) and R^2(GP). */
  volR2: number;
  volRelMse: number;
  /** RMSE (in summed 9-cat z units) of the naive "next = previous" prediction: per 36 and per game. */
  rmseSumZ36: number;
  rmseSumZGame: number;
}

export interface BacktestResult {
  pairs: number;
  groups: GroupResult[];
  /** Minutes elasticity: d ln(MPG) / d ln(production per game), over all pairs (least squares through the origin). */
  minutesElasticity: number;
  /** Corr of d ln MPG with d ln production. */
  minutesElasticityR: number;
}

const RATE_METRICS: Metric[] = [...CATEGORIES];

export function runBacktest(prev: SeasonRow[], next: SeasonRow[], opts: { minGp?: number; poolSize?: number } = {}): BacktestResult {
  const pairs = pairSeasons(prev, next, opts.minGp ?? 20);
  const zPrev = seasonZ(prev.filter((r) => r.line.minutes > 0), opts.poolSize);
  const zNext = seasonZ(next.filter((r) => r.line.minutes > 0), opts.poolSize);

  // Pooled regressions (the basis of relMse): one fit per metric over every pair.
  const all = (m: Metric) => metricSamples(pairs, zPrev, zNext, m);
  const pooled = new Map<Metric, Fit>();
  for (const m of [...RATE_METRICS, "MPG", "GP", "SUM_Z36", "SUM_ZG"] as Metric[]) {
    const s = all(m);
    pooled.set(m, ols(s.prev, s.next));
  }

  const groups: GroupResult[] = GROUPS.map((g) => {
    const members = pairs.filter(g.test);
    const metrics: MetricStat[] = ([...RATE_METRICS, "MPG", "GP"] as Metric[]).map((m) => {
      const s = metricSamples(members, zPrev, zNext, m);
      const fit = ols(s.prev, s.next);
      const pf = pooled.get(m)!;
      const resid = s.prev.map((x, i) => s.next[i] - (pf.a + pf.b * x));
      const sdNext = Math.sqrt(variance(s.next)) || 1;
      return {
        metric: m,
        n: s.prev.length,
        r: fit.r,
        r2: fit.r2,
        nrmse: rmse(s.prev, s.next) / sdNext,
        relMse: pf.varY > 0 ? mean(resid.map((e) => e * e)) / pf.varY : 0,
      };
    });
    const rate = metrics.filter((m) => RATE_METRICS.includes(m.metric));
    const vol = metrics.filter((m) => m.metric === "MPG" || m.metric === "GP");
    const z36 = metricSamples(members, zPrev, zNext, "SUM_Z36");
    const zg = metricSamples(members, zPrev, zNext, "SUM_ZG");
    return {
      id: g.id,
      label: g.label,
      n: members.length,
      metrics,
      rateR2: mean(rate.map((m) => m.r2)),
      rateRelMse: mean(rate.map((m) => m.relMse)),
      volR2: mean(vol.map((m) => m.r2)),
      volRelMse: mean(vol.map((m) => m.relMse)),
      rmseSumZ36: rmse(z36.prev, z36.next),
      rmseSumZGame: rmse(zg.prev, zg.next),
    };
  });

  // Minutes elasticity from within-player changes.
  const dm: number[] = [];
  const dp: number[] = [];
  for (const p of pairs) {
    const a = production(p.prev.line);
    const b = production(p.next.line);
    if (a > 1 && b > 1) {
      dm.push(Math.log(p.next.line.minutes / p.prev.line.minutes));
      dp.push(Math.log(b / a));
    }
  }
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < dm.length; i++) {
    sxy += dm[i] * dp[i];
    sxx += dp[i] * dp[i];
    syy += dm[i] * dm[i];
  }
  return {
    pairs: pairs.length,
    groups,
    minutesElasticity: sxx > 0 ? sxy / sxx : 0.5,
    minutesElasticityR: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0,
  };
}

// ------------------------------------------------------------------ calibration

export interface CalibrationOptions {
  /** Yahoo error relative to the pooled-regression error (see module doc). */
  kappa: number;
  min: number;
  max: number;
}

/** Yahoo (projection) weight for a group's rates / volume from its relative errors; clamped to [min, max]. */
export function yahooWeight(groupRelMse: number, pooledRelMse: number, o: CalibrationOptions): number {
  const sY = o.kappa * pooledRelMse;
  const wReal = sY + groupRelMse > 0 ? sY / (sY + groupRelMse) : 0.5;
  return Math.min(o.max, Math.max(o.min, 1 - wReal));
}

/**
 * kappa such that the pooled ("all") rate group gets exactly `anchor` Yahoo weight: w_real = kappa/(kappa+1) = 1 - anchor
 * => kappa = (1 - anchor) / anchor.
 */
export const kappaForAnchor = (anchor: number) => (1 - anchor) / anchor;

export interface GroupWeights {
  id: string;
  wRate: number;
  wVol: number;
}

export function calibrate(res: BacktestResult, o: CalibrationOptions): GroupWeights[] {
  const all = res.groups.find((g) => g.id === "all")!;
  return res.groups.map((g) => ({
    id: g.id,
    wRate: yahooWeight(g.rateRelMse, all.rateRelMse, o),
    wVol: yahooWeight(g.volRelMse, all.volRelMse, o),
  }));
}

export function formatBacktest(res: BacktestResult, o: CalibrationOptions): string {
  const w = new Map(calibrate(res, o).map((x) => [x.id, x]));
  const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "  - ");
  const lines: string[] = [];
  lines.push(`pairs (>=20 GP both seasons): ${res.pairs}   minutes elasticity d ln MPG / d ln PROD = ${f(res.minutesElasticity, 3)} (r ${f(res.minutesElasticityR, 2)})`);
  lines.push("");
  lines.push("group".padEnd(46) + "n".padStart(5) + "rateR2".padStart(8) + "volR2".padStart(7) + "rate err".padStart(9) + "vol err".padStart(8) + "RMSEz36".padStart(9) + "RMSEzG".padStart(8) + "  Yahoo wRate wVol");
  for (const g of res.groups) {
    const c = w.get(g.id)!;
    lines.push(
      g.label.slice(0, 45).padEnd(46) + String(g.n).padStart(5) + f(g.rateR2).padStart(8) + f(g.volR2).padStart(7) + f(g.rateRelMse).padStart(9) + f(g.volRelMse).padStart(8) +
        f(g.rmseSumZ36).padStart(9) + f(g.rmseSumZGame).padStart(8) + `   ${f(c.wRate)}  ${f(c.wVol)}`,
    );
  }
  lines.push("");
  lines.push("per-category R^2 (last season's per-36 z -> next season's) by group:");
  lines.push("group".padEnd(12) + [...CATEGORIES, "MPG", "GP"].map((c) => c.padStart(6)).join(""));
  for (const g of res.groups) lines.push(g.id.padEnd(12) + g.metrics.map((m) => f(m.r2).padStart(6)).join(""));
  lines.push("");
  lines.push("per-category RMSE of naive next=prev (in SDs of next season) by group:");
  lines.push("group".padEnd(12) + [...CATEGORIES, "MPG", "GP"].map((c) => c.padStart(6)).join(""));
  for (const g of res.groups) lines.push(g.id.padEnd(12) + g.metrics.map((m) => f(m.nrmse).padStart(6)).join(""));
  return lines.join("\n");
}
