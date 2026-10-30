/** Snake-draft pick math. Pure; all numbers 1-based. Never hard-code positions. */

function assertInt(name: string, v: number, min: number): void {
  if (!Number.isInteger(v) || v < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`);
  }
}

function assertLeague(teams: number, slot?: number): void {
  assertInt("teams", teams, 2);
  if (slot !== undefined) {
    assertInt("slot", slot, 1);
    if (slot > teams) throw new RangeError(`slot ${slot} exceeds teams ${teams}`);
  }
}

export function totalPicks(teams: number, rounds: number): number {
  assertInt("teams", teams, 1);
  assertInt("rounds", rounds, 0);
  return teams * rounds;
}

/** Who owns overall pick `pick`: odd rounds ascend, even rounds descend. */
export function pickOwner(pick: number, teams: number): { round: number; teamSlot: number } {
  assertInt("pick", pick, 1);
  assertLeague(teams);
  const round = Math.floor((pick - 1) / teams) + 1;
  const idx = (pick - 1) % teams; // 0-based position within round
  const teamSlot = round % 2 === 1 ? idx + 1 : teams - idx;
  return { round, teamSlot };
}

/** Overall pick number of `slot` in `round`. */
function pickInRound(round: number, teams: number, slot: number): number {
  return round % 2 === 1 ? (round - 1) * teams + slot : round * teams - slot + 1;
}

/** All overall picks for `slot`, one per round. 14/13/13 → [13,16,41,44,...,181]. */
export function userPicks(teams: number, slot: number, rounds: number): number[] {
  assertLeague(teams, slot);
  assertInt("rounds", rounds, 0);
  const out: number[] = [];
  for (let r = 1; r <= rounds; r++) out.push(pickInRound(r, teams, slot));
  return out;
}

export function isUserPick(pick: number, teams: number, slot: number): boolean {
  assertLeague(teams, slot);
  assertInt("pick", pick, 1);
  return pickOwner(pick, teams).teamSlot === slot;
}

/** First user pick >= currentPick, or null if none remain. */
export function nextUserPick(
  currentPick: number,
  teams: number,
  slot: number,
  rounds: number,
): number | null {
  assertInt("currentPick", currentPick, 1);
  for (const p of userPicks(teams, slot, rounds)) if (p >= currentPick) return p;
  return null;
}

/** First user pick strictly > currentPick, or null. */
export function nextUserPickAfter(
  currentPick: number,
  teams: number,
  slot: number,
  rounds: number,
): number | null {
  assertInt("currentPick", currentPick, 0);
  return nextUserPick(currentPick + 1, teams, slot, rounds);
}
