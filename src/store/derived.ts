import { isUserPick, nextUserPick, nextUserPickAfter, pickOwner } from "@/engine";
import type { DraftState } from "@/types";

export interface DraftDerived {
  complete: boolean;
  currentPick: number;
  /** Team slot on the clock (null when complete). */
  onClockSlot: number | null;
  isUserOnClock: boolean;
  /** Pick used as the "next" display: user's next pick at or after the current one. */
  userNextPick: number | null;
  /** Pick the survival simulation targets (strictly after current when on the clock). */
  survivalTarget: number | null;
  userRosterIds: string[];
  draftedIds: string[];
  rosterSize: number;
}

export function deriveDraft(d: DraftState | null): DraftDerived | null {
  if (!d) return null;
  const complete = d.status === "complete";
  const draftedIds = d.picks.map((p) => p.playerId);
  const userRosterIds = d.picks.filter((p) => p.teamSlot === d.userSlot).map((p) => p.playerId);
  if (complete) {
    return {
      complete, currentPick: d.currentPick, onClockSlot: null, isUserOnClock: false,
      userNextPick: null, survivalTarget: null, userRosterIds, draftedIds, rosterSize: d.rounds,
    };
  }
  const isUserOnClock = isUserPick(d.currentPick, d.teams, d.userSlot);
  const userNextPick = nextUserPick(d.currentPick, d.teams, d.userSlot, d.rounds);
  const survivalTarget = isUserOnClock
    ? nextUserPickAfter(d.currentPick, d.teams, d.userSlot, d.rounds)
    : userNextPick;
  return {
    complete,
    currentPick: d.currentPick,
    onClockSlot: pickOwner(d.currentPick, d.teams).teamSlot,
    isUserOnClock,
    userNextPick,
    survivalTarget,
    userRosterIds,
    draftedIds,
    rosterSize: d.rounds,
  };
}


/** Deterministic simulation seed from draft id + current pick (shared by the app store and the server recommendations). */
export function simSeed(draftId: number, currentPick: number): number {
  return (Math.imul(draftId + 1, 2654435761) ^ Math.imul(currentPick + 7, 40503)) >>> 0;
}
