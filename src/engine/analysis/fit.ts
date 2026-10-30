import { VALUE_EPS } from "@/engine/draft/opponent";
import { createRng } from "@/engine/draft/rng";
import type { OpponentModelParams, SimPlayer } from "@/types";
import { brier, calibrateDraft } from "./calibration";
import { MAX_BEHAVIOR_ADP, type AnalysisDraft } from "./types";

/** One observed opponent pick: the candidates that were available (best ADP first) and who was taken. */
export interface FitObservation {
  draftId: number;
  pick: number;
  teamSlot: number;
  /** Available players, best ADP first, capped at `topCandidates` but always containing the chosen one. */
  candidates: SimPlayer[];
  chosenIdx: number;
  /** The chosen player is the best available by ADP (what an autopick would take). */
  isAdpTop: boolean;
}

/** Every non-user pick of the draft with the pool still available at that moment. Picks of players outside `pool` are skipped. */
export function buildObservations(draft: AnalysisDraft, pool: SimPlayer[], topCandidates = 80): FitObservation[] {
  const byAdp = pool.slice().sort((a, b) => a.adp - b.adp);
  const byId = new Map(pool.map((p) => [p.id, p]));
  const taken = new Set<string>();
  const out: FitObservation[] = [];
  let head = 0;
  for (const k of draft.picks.slice().sort((a, b) => a.pick - b.pick)) {
    const chosen = byId.get(k.playerId);
    while (head < byAdp.length && taken.has(byAdp[head].id)) head++;
    if (chosen && k.teamSlot !== draft.userSlot && !taken.has(chosen.id) && chosen.adp <= MAX_BEHAVIOR_ADP) {
      const cands: SimPlayer[] = [];
      for (let i = head; i < byAdp.length && cands.length < topCandidates; i++) if (!taken.has(byAdp[i].id)) cands.push(byAdp[i]);
      if (!cands.includes(chosen)) cands.push(chosen);
      out.push({ draftId: draft.id, pick: k.pick, teamSlot: k.teamSlot, candidates: cands, chosenIdx: cands.indexOf(chosen), isAdpTop: byAdp[head] === chosen });
    }
    taken.add(k.playerId);
  }
  return out;
}

export interface FitOptions {
  ks?: number[];
  autopickShares?: number[];
  /** Monte Carlo samples per observation and k (common random numbers across k). */
  samples?: number;
  seed?: number;
}

export interface FitResult extends OpponentModelParams {
  /** Total log-likelihood at (k, autopickShare). */
  logLik: number;
  /** Log-likelihood at the default model (k = 1, no autopick). */
  logLikDefault: number;
  n: number;
  /** Log-likelihood per k at the best autopickShare, and with autopickShare 0. */
  surface: { k: number; logLik: number; logLikNoAuto: number }[];
}

const range = (a: number, b: number, step: number): number[] => {
  const out: number[] = [];
  for (let x = a; x <= b + 1e-9; x += step) out.push(Math.round(x * 100) / 100);
  return out;
};

/**
 * Maximum-likelihood fit of the opponent model to observed picks. Per pick the model is the one `pickForOpponent` uses
 * (key = adp + k * sigma * N(0,1) - VALUE_EPS * value, lowest key wins), so P(chosen) is estimated by Monte Carlo with
 * common random numbers across k and a small additive smoothing (so rare reaches stay finite). A mixture weight `a` adds
 * "autopick": P = a * [chosen is best by ADP] + (1 - a) * P_model(k). Pseudo-likelihood: each pick is scored independently
 * given the picks before it.
 */
export function fitOpponentModel(obs: FitObservation[], opts: FitOptions = {}): FitResult {
  const ks = opts.ks ?? range(0.5, 4.0, 0.1);
  const as = opts.autopickShares ?? range(0, 0.6, 0.05);
  const M = opts.samples ?? 600;
  const seed = opts.seed ?? 12345;
  // pm[ki][oi] = smoothed model probability of the chosen player
  const pm: Float64Array[] = ks.map(() => new Float64Array(obs.length));
  for (let oi = 0; oi < obs.length; oi++) {
    const o = obs[oi];
    const C = o.candidates.length;
    const rng = createRng((seed ^ Math.imul(oi + 1, 2654435761)) >>> 0);
    const z = new Float64Array(M * C);
    for (let i = 0; i < z.length; i++) z[i] = rng.normal();
    const base = o.candidates.map((p) => p.adp - VALUE_EPS * p.value);
    const sd = o.candidates.map((p) => p.adpStdDev);
    for (let ki = 0; ki < ks.length; ki++) {
      const k = ks[ki];
      let wins = 0;
      for (let m = 0; m < M; m++) {
        let best = Infinity;
        let arg = -1;
        const off = m * C;
        for (let j = 0; j < C; j++) {
          const key = base[j] + k * sd[j] * z[off + j];
          if (key < best) {
            best = key;
            arg = j;
          }
        }
        if (arg === o.chosenIdx) wins++;
      }
      pm[ki][oi] = (wins + 0.5) / (M + 1);
    }
  }
  const ll = (ki: number, a: number): number => {
    let s = 0;
    for (let oi = 0; oi < obs.length; oi++) s += Math.log(a * (obs[oi].isAdpTop ? 1 : 0) + (1 - a) * pm[ki][oi]);
    return s;
  };
  let best = { ki: 0, a: 0, ll: -Infinity };
  for (let ki = 0; ki < ks.length; ki++) for (const a of as) {
    const v = ll(ki, a);
    if (v > best.ll) best = { ki, a, ll: v };
  }
  const k1 = ks.reduce((bi, k, i) => (Math.abs(k - 1) < Math.abs(ks[bi] - 1) ? i : bi), 0);
  return {
    k: ks[best.ki], autopickShare: best.a, logLik: best.ll, logLikDefault: ll(k1, 0), n: obs.length,
    surface: ks.map((k, ki) => ({ k, logLik: ll(ki, best.a), logLikNoAuto: ll(ki, 0) })),
  };
}

/** Best k on the fit surface restricted to [lo, hi] (the spec's 0.5-2.0 range), with the autopick share held at the overall fit. */
export function bestKWithin(fit: FitResult, lo = 0.5, hi = 2.0): { k: number; logLik: number } {
  const inRange = fit.surface.filter((s) => s.k >= lo - 1e-9 && s.k <= hi + 1e-9);
  return inRange.reduce((b, s) => (s.logLik > b.logLik ? { k: s.k, logLik: s.logLik } : b), { k: inRange[0]?.k ?? fit.k, logLik: -Infinity });
}

/** Brier score of the survival replay (calibrateDraft) over the drafts for each candidate model (for reporting / a cross-check of the fit). */
export function brierByModel(drafts: AnalysisDraft[], pool: SimPlayer[], models: OpponentModelParams[], simulations = 5000): { model: OpponentModelParams; brier: number; n: number }[] {
  return models.map((model) => {
    const pts = drafts.flatMap((d) => calibrateDraft(d, pool, { simulations, model }));
    return { model, brier: brier(pts), n: pts.length };
  });
}
