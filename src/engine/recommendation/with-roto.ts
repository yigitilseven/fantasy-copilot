import type { OpponentModelParams, PlayerRecord, PlayerScore } from "@/types";
import { analyzeRoto, DEFAULT_SIMS, type RotoAnalysis, type RotoPlayerInput } from "../standings-opt/expected";
import { viewLinesOf } from "../standings-opt/lines";
import { objectiveParamsFor, type ObjectiveMode, type ObjectiveParams } from "../standings-opt/objective";
import { scorePlayers, type RecommendInput } from "./score";
import { objectiveModeOf } from "./strategy";

/** Everything the standings analysis needs beyond the scoring input (the draft shape and the other teams' rosters). */
export interface RotoContext {
  teams: number;
  rounds: number;
  userSlot: number;
  /** Players drafted per team, index = slot - 1. */
  rosters: string[][];
  model?: OpponentModelParams;
  seed: number;
  sims?: number;
  /** Override the strategy's objective parameters (backtest tuning). */
  objective?: ObjectiveParams;
  /** Candidate count taken from the classic ranking (default 18). */
  classicTop?: number;
  /** Proj-view fallback to the record's projection for players Yahoo has no line for (see viewLinesOf). */
  fallbackProj?: boolean;
}

export interface RotoScored {
  scores: PlayerScore[];
  roto: RotoAnalysis | null;
}

/** Packs the universe for analyzeRoto. */
export function rotoPlayers(records: PlayerRecord[], valuations: RecommendInput["valuations"], fallbackProj?: boolean): RotoPlayerInput[] {
  return records.map((r) => ({
    id: r.player.id,
    adp: r.market.yahooAdp,
    adpSd: r.market.adpStdDev,
    value: valuations[r.player.id]?.nineCat ?? 0,
    lines: viewLinesOf(r, { fallbackProj }),
  }));
}

/**
 * Two-phase scoring with the standings model: (1) classic scores pick the candidates (top by risk-adjusted score; the analyzer adds the
 * top ADPs and the players with the best surrogate gain at the current roster), (2) analyzeRoto evaluates them over R draft completions,
 * (3) the scores are recomputed with the Roto dimension. "classic" objective (or no remaining user picks) = plain scorePlayers.
 */
export function scoreWithRoto(input: RecommendInput, ctx: RotoContext, mode?: ObjectiveMode): RotoScored {
  const m = mode ?? objectiveModeOf(input.strategy);
  const objective = ctx.objective ?? objectiveParamsFor(m);
  const base = scorePlayers(input);
  if (!objective || base.length === 0) return { scores: base, roto: null };
  const top = base.filter((s) => s.recommendation !== "AVOID").slice(0, ctx.classicTop ?? 18).map((s) => s.playerId);
  const roto = analyzeRoto({
    teams: ctx.teams, rounds: ctx.rounds, userSlot: ctx.userSlot, currentPick: input.currentPick, rosters: ctx.rosters,
    players: rotoPlayers(input.records, input.valuations, ctx.fallbackProj), model: ctx.model, seed: ctx.seed, sims: ctx.sims ?? DEFAULT_SIMS,
    objective, candidates: top,
  });
  if (Object.keys(roto.candidates).length === 0) return { scores: base, roto };
  return { scores: scorePlayers({ ...input, roto }), roto };
}
