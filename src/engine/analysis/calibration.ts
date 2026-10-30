import { leagueConfig } from "@/config/default-league";
import { nextUserPickAfter } from "@/engine/draft/snake";
import { survivalToNextPick } from "@/engine/draft/survival";
import { simSeed } from "@/store/derived";
import type { OpponentModelParams, SimPlayer } from "@/types";
import type { AnalysisDraft } from "./types";

export interface CalibrationPoint {
  draftId: number;
  /** The user's pick (decision point; the user is on the clock). */
  decisionPick: number;
  /** The user's next pick: the survival target. */
  targetPick: number;
  playerId: string;
  adp: number;
  predicted: number;
  /** 1 = the player was still available at targetPick. */
  observed: 0 | 1;
}

export interface CalibrationOptions {
  simulations?: number;
  /** Number of best-ADP available players evaluated per decision point. */
  topN?: number;
  model?: OpponentModelParams;
  seedFn?: (draftId: number, pick: number) => number;
}

/**
 * Replays each of the user's picks in a finished (or partial) draft: the state is the recorded picks before it, the
 * simulation is exactly what the app runs (same engine, default simulations, seed = simSeed(draftId, pick)), and the
 * prediction P(still available at the user's next pick) for the top-N available is compared with what happened.
 * The player the user took at the decision pick is censored (we do not know whether he would have lasted) and skipped,
 * as are decision points whose target window is not fully recorded.
 */
export function calibrateDraft(draft: AnalysisDraft, pool: SimPlayer[], opts: CalibrationOptions = {}): CalibrationPoint[] {
  const sims = opts.simulations ?? leagueConfig.simulations;
  const topN = opts.topN ?? 30;
  const seedFn = opts.seedFn ?? simSeed;
  const picks = draft.picks.slice().sort((a, b) => a.pick - b.pick);
  const lastRecorded = picks.length ? picks[picks.length - 1].pick : 0;
  const pickerOf = new Map(picks.map((k) => [k.pick, k.playerId]));
  const out: CalibrationPoint[] = [];
  for (const mine of picks.filter((k) => k.teamSlot === draft.userSlot)) {
    const target = nextUserPickAfter(mine.pick, draft.teams, draft.userSlot, draft.rounds);
    if (target === null || lastRecorded < target - 1) continue;
    const before = new Set(picks.filter((k) => k.pick < mine.pick).map((k) => k.playerId));
    const available = pool.filter((p) => !before.has(p.id));
    const res = survivalToNextPick({
      currentPick: mine.pick, teams: draft.teams, userSlot: draft.userSlot, rounds: draft.rounds,
      players: available, simulations: sims, seed: seedFn(draft.id, mine.pick), ...(opts.model ? { model: opts.model } : {}),
    });
    if (!res) continue;
    const gone = new Set<string>();
    for (let p = mine.pick + 1; p < res.targetPick; p++) {
      const id = pickerOf.get(p);
      if (id) gone.add(id);
    }
    const top = available.slice().sort((a, b) => a.adp - b.adp).slice(0, topN);
    for (const p of top) {
      if (p.id === mine.playerId) continue;
      out.push({
        draftId: draft.id, decisionPick: mine.pick, targetPick: res.targetPick, playerId: p.id, adp: p.adp,
        predicted: res.result.survival[p.id] ?? 1, observed: gone.has(p.id) ? 0 : 1,
      });
    }
  }
  return out;
}

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number;
  observedRate: number;
}

/** Predicted-probability buckets (default ten: 0-10% ... 90-100%) against the observed availability rate. */
export function reliability(points: CalibrationPoint[], buckets = 10): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const xs = points.filter((p) => p.predicted >= lo && (b === buckets - 1 ? p.predicted <= hi : p.predicted < hi));
    out.push({
      lo, hi, n: xs.length,
      meanPredicted: xs.length ? xs.reduce((a, p) => a + p.predicted, 0) / xs.length : 0,
      observedRate: xs.length ? xs.reduce((a, p) => a + p.observed, 0) / xs.length : 0,
    });
  }
  return out;
}

/** Mean squared error of the predicted probabilities (0 = perfect; 0.25 = always guessing 50%). */
export function brier(points: CalibrationPoint[]): number {
  return points.length ? points.reduce((a, p) => a + (p.predicted - p.observed) ** 2, 0) / points.length : 0;
}
