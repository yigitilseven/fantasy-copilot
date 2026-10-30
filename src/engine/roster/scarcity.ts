import type { PlayerRecord, PlayerValuation, Position, RosterSlot } from "@/types";
import { POSITIONS } from "@/types";

const SLOTS_FOR_POSITION: Record<Position, RosterSlot[]> = {
  PG: ["PG", "G", "UTIL", "BN"],
  SG: ["SG", "G", "UTIL", "BN"],
  SF: ["SF", "F", "UTIL", "BN"],
  PF: ["PF", "F", "UTIL", "BN"],
  C: ["C", "UTIL", "BN"],
};
const MAX_SLOT_TYPES = 9; // PG SG SF PF C G F UTIL BN

/** Distinct eligible roster slot types, normalized to 0..1 (n / 9). */
export function flexibility(positions: Position[]): number {
  const set = new Set<RosterSlot>();
  for (const p of positions) for (const s of SLOTS_FOR_POSITION[p]) set.add(s);
  return set.size / MAX_SLOT_TYPES;
}

/** Per-team demand for a position: dedicated slots plus half of each G/F slot. */
function demandPerTeam(pos: Position, slots: RosterSlot[]): number {
  let d = 0;
  for (const s of slots) {
    if (s === pos) d += 1;
    else if (s === "G" && (pos === "PG" || pos === "SG")) d += 0.5;
    else if (s === "F" && (pos === "SF" || pos === "PF")) d += 0.5;
  }
  return d;
}

/**
 * Raw scarcity index per player: for each position, league demand (teams * slots)
 * divided by (1 + count of available players with nineCat > 0 at that position).
 * A player's scarcity is the max over his positions. Higher = scarcer.
 */
export function positionalScarcity(
  available: PlayerRecord[],
  valuations: Record<string, PlayerValuation>,
  opts: { teams: number; rosterSlots: readonly RosterSlot[] },
): Record<string, number> {
  const index = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const demand = opts.teams * demandPerTeam(pos, [...opts.rosterSlots]);
    const quality = available.filter(
      (r) => r.player.positions.includes(pos) && (valuations[r.player.id]?.nineCat ?? 0) > 0,
    ).length;
    index[pos] = demand / (1 + quality);
  }
  const out: Record<string, number> = {};
  for (const r of available) {
    out[r.player.id] = r.player.positions.length
      ? Math.max(...r.player.positions.map((p) => index[p]))
      : 0;
  }
  return out;
}

/**
 * Value over replacement. Remaining league roster spots = teams*slots - picksMade.
 * Each position's replacement rank is that total scaled by the position's demand share
 * (min 1); replacement level = nineCat of the available player at that rank in the
 * position's list (clamped to the last player). A player uses the lowest replacement
 * level among his positions (highest VORP).
 */
export function valueOverReplacement(
  available: PlayerRecord[],
  valuations: Record<string, PlayerValuation>,
  opts: { teams: number; rosterSlots: readonly RosterSlot[]; picksMade: number },
): Record<string, number> {
  const slots = [...opts.rosterSlots];
  const remaining = Math.max(1, opts.teams * slots.length - opts.picksMade);
  const totalDemand = POSITIONS.reduce((s, p) => s + demandPerTeam(p, slots), 0) || 1;
  const nine = (r: PlayerRecord) => valuations[r.player.id]?.nineCat ?? 0;

  const replacement = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const list = available.filter((r) => r.player.positions.includes(pos)).map(nine).sort((a, b) => b - a);
    if (list.length === 0) { replacement[pos] = 0; continue; }
    const rank = Math.max(1, Math.round((remaining * demandPerTeam(pos, slots)) / totalDemand));
    replacement[pos] = list[Math.min(rank, list.length) - 1];
  }
  const out: Record<string, number> = {};
  for (const r of available) {
    const levels = r.player.positions.map((p) => replacement[p]);
    out[r.player.id] = nine(r) - (levels.length ? Math.min(...levels) : 0);
  }
  return out;
}
