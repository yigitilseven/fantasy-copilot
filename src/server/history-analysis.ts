import type { Db } from "@/db/client";
import { cleanDraftIds, listDraftSummaries, loadAnalysisDraft, loadStoredModel, saveOpponentModel } from "@/db/history";
import { DraftError, getAllPlayerRecords } from "@/db/repository";
import {
  PLAYER_MAP, bestKWithin, biggestReachesSteals, brier, buildObservations, calibrateDraft, detectAutopicks, deviationByRound, fitOpponentModel, managerStats,
  overallWithinSigma, pickDeviations, positionalRuns, reliability,
  type AnalysisDraft, type AnalysisPlayer, type FitResult,
} from "@/engine/analysis";
import { computeValuations } from "@/engine/valuation/value";
import { buildSimPlayers } from "@/engine";
import type { OpponentModelParams, SimPlayer } from "@/types";

export interface AnalysisInputs {
  players: AnalysisPlayer[];
  pool: SimPlayer[];
}

export function loadAnalysisInputs(db: Db): AnalysisInputs {
  const records = getAllPlayerRecords(db);
  const { valuations } = computeValuations(records);
  const players: AnalysisPlayer[] = records.map((r) => ({
    id: r.player.id, name: r.player.name, positions: r.player.positions, adp: r.market.yahooAdp, adpStdDev: r.market.adpStdDev,
    rank: r.market.rank, value: valuations[r.player.id]?.nineCat ?? 0,
  }));
  const pool = buildSimPlayers(records.map((r) => ({ id: r.player.id, adp: r.market.yahooAdp, adpStdDev: r.market.adpStdDev, value: valuations[r.player.id]?.nineCat ?? 0, positions: r.player.positions })));
  return { players, pool };
}

export function loadCleanDrafts(db: Db, ids?: number[]): AnalysisDraft[] {
  return (ids ?? cleanDraftIds(db)).map((id) => loadAnalysisDraft(db, id)).filter((d): d is AnalysisDraft => !!d && d.picks.length > 0);
}

export interface CalibrationReport {
  n: number;
  brier: number;
  reliability: ReturnType<typeof reliability>;
  perDraft: { draftId: number; n: number; brier: number }[];
}

export function calibrationReport(drafts: AnalysisDraft[], pool: SimPlayer[], opts: { simulations?: number; model?: OpponentModelParams } = {}): CalibrationReport {
  const all = drafts.flatMap((d) => calibrateDraft(d, pool, opts));
  return {
    n: all.length, brier: brier(all), reliability: reliability(all),
    perDraft: drafts.map((d) => {
      const pts = all.filter((p) => p.draftId === d.id);
      return { draftId: d.id, n: pts.length, brier: brier(pts) };
    }),
  };
}

export function fitFromDrafts(drafts: AnalysisDraft[], pool: SimPlayer[], opts: { samples?: number } = {}): FitResult {
  return fitOpponentModel(drafts.flatMap((d) => buildObservations(d, pool)), { samples: opts.samples });
}

/** Fits the opponent model on the clean drafts and stores it (disabled unless it already was enabled). */
export function refitAndSave(db: Db, opts: { samples?: number; ids?: number[] } = {}): FitResult & { draftIds: number[] } {
  const { pool } = loadAnalysisInputs(db);
  const drafts = loadCleanDrafts(db, opts.ids);
  const fit = fitFromDrafts(drafts, pool, opts);
  if (fit.n < 30) throw new DraftError("INVALID_CONFIG", `Not enough clean yahoo-live picks to fit the model (${fit.n}, need 30)`);
  const draftIds = drafts.map((d) => d.id);
  // The likelihood optimum can drift high (2.9 on 5 drafts) where survival predictions get worse; keep k in the
  // spec's 0.5–2.0 range (survival Brier over drafts 6–11 is flat-best at 1.7–2.0).
  const k = bestKWithin(fit).k;
  saveOpponentModel(db, { k, autopickShare: fit.autopickShare }, { logLik: fit.logLik, logLikDefault: fit.logLikDefault, n: fit.n, draftIds, surface: fit.surface });
  return { ...fit, k, draftIds };
}

export interface HistoryAnalysis {
  draftIds: number[];
  reach: {
    n: number;
    byRound: ReturnType<typeof deviationByRound>;
    withinSigma: number;
    reaches: ReturnType<typeof biggestReachesSteals>["reaches"];
    steals: ReturnType<typeof biggestReachesSteals>["steals"];
  };
  runs: { draftId: number; windows: number; flagged: number; byRound: ReturnType<typeof positionalRuns>["byRound"]; byPosition: ReturnType<typeof positionalRuns>["byPosition"]; runs: ReturnType<typeof positionalRuns>["runs"] }[];
  autopick: { draftId: number; byTeam: ReturnType<typeof detectAutopicks>["byTeam"] }[];
  managers: ReturnType<typeof managerStats>;
  calibration: CalibrationReport;
  model: ReturnType<typeof loadStoredModel>;
}

/** Everything the /history page and the report CLI show, over clean yahoo-live drafts (or the given ids). */
export function runHistoryAnalysis(db: Db, opts: { ids?: number[]; simulations?: number } = {}): HistoryAnalysis {
  const { players, pool } = loadAnalysisInputs(db);
  const map = PLAYER_MAP(players);
  const drafts = loadCleanDrafts(db, opts.ids);
  const devs = pickDeviations(drafts, map);
  const { reaches, steals } = biggestReachesSteals(devs, 10);
  return {
    draftIds: drafts.map((d) => d.id),
    reach: { n: devs.length, byRound: deviationByRound(devs), withinSigma: overallWithinSigma(devs), reaches, steals },
    runs: drafts.map((d) => {
      const r = positionalRuns(d, map);
      return { draftId: d.id, windows: r.windows, flagged: r.flagged, byRound: r.byRound, byPosition: r.byPosition, runs: r.runs };
    }),
    autopick: drafts.map((d) => ({ draftId: d.id, byTeam: detectAutopicks(d, map).byTeam })),
    managers: managerStats(drafts, map),
    calibration: calibrationReport(drafts, pool, { simulations: opts.simulations }),
    model: loadStoredModel(db),
  };
}

export { listDraftSummaries };
