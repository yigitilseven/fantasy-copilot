import type { OpponentModelParams, Position, SimPlayer, SimulationInput, SimulationResult } from "@/types";
import { isUserPick, nextUserPick, nextUserPickAfter } from "./snake";
import { simulateSurvival } from "./simulator";

export interface SimPlayerLike {
  id: string;
  adp: number;
  adpStdDev: number;
  value: number;
  positions: Position[];
}

export function buildSimPlayers(records: SimPlayerLike[]): SimPlayer[] {
  return records.map((r) => ({
    id: r.id,
    adp: r.adp,
    adpStdDev: r.adpStdDev,
    value: r.value,
    positions: r.positions,
  }));
}

export interface SurvivalToNextPickArgs {
  currentPick: number;
  teams: number;
  userSlot: number;
  rounds: number;
  players: SimPlayer[];
  simulations: number;
  seed: number;
  model?: OpponentModelParams;
}

/**
 * Plain SimulationInput for the survival-to-next-pick question: target is strictly after
 * currentPick when the user is on the clock, otherwise the next user pick. Null when no
 * future pick exists. User picks inside [currentPick, target) are skipped.
 */
export function buildSurvivalInput(
  a: SurvivalToNextPickArgs,
): { targetPick: number; input: SimulationInput } | null {
  const onClock = isUserPick(a.currentPick, a.teams, a.userSlot);
  const targetPick = onClock
    ? nextUserPickAfter(a.currentPick, a.teams, a.userSlot, a.rounds)
    : nextUserPick(a.currentPick, a.teams, a.userSlot, a.rounds);
  if (targetPick === null) return null;
  const skipPicks: number[] = [];
  for (let p = a.currentPick; p < targetPick; p++) {
    if (isUserPick(p, a.teams, a.userSlot)) skipPicks.push(p);
  }
  return {
    targetPick,
    input: {
      currentPick: a.currentPick,
      targetPick,
      teams: a.teams,
      players: a.players,
      simulations: a.simulations,
      seed: a.seed,
      skipPicks,
      ...(a.model ? { model: a.model } : {}),
    },
  };
}

/** Survival to the user's next pick (see buildSurvivalInput). */
export function survivalToNextPick(
  a: SurvivalToNextPickArgs,
): { targetPick: number; result: SimulationResult } | null {
  const built = buildSurvivalInput(a);
  if (!built) return null;
  return { targetPick: built.targetPick, result: simulateSurvival(built.input) };
}
