import type { Position } from "@/types";

/** Yahoo slot eligibility: G = PG/SG, F = SF/PF, UTIL = anybody, a position slot needs that position. */
export function slotAccepts(slot: string, positions: readonly Position[]): boolean {
  switch (slot) {
    case "UTIL": return true;
    case "G": return positions.includes("PG") || positions.includes("SG");
    case "F": return positions.includes("SF") || positions.includes("PF");
    case "PG": case "SG": case "SF": case "PF": case "C": return positions.includes(slot);
    default: return false;
  }
}

const BREADTH: Record<string, number> = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0, G: 1, F: 1, UTIL: 2 };

export interface SlotCandidate {
  id: string;
  positions: readonly Position[];
  /** Higher = start first. */
  value: number;
}

/**
 * Optimal start/sit assignment: picks the max-total-value set of candidates that fits the slots (weights are per player, so this is a
 * transversal matroid and "insert by descending value with an augmenting path" is exact). Specific position slots are preferred over
 * G/F over UTIL so UTIL stays free for flexibility. Returns, per slot index, the candidate id or null.
 */
export function assignSlots(candidates: readonly SlotCandidate[], slots: readonly string[]): (string | null)[] {
  const order = [...candidates].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const slotOrder = slots.map((_, i) => i).sort((a, b) => (BREADTH[slots[a]] ?? 3) - (BREADTH[slots[b]] ?? 3) || a - b);
  const owner: number[] = slots.map(() => -1);
  const place = (ci: number, seen: Set<number>): boolean => {
    for (const si of slotOrder) {
      if (seen.has(si) || !slotAccepts(slots[si], order[ci].positions)) continue;
      seen.add(si);
      if (owner[si] === -1 || place(owner[si], seen)) {
        owner[si] = ci;
        return true;
      }
    }
    return false;
  };
  for (let ci = 0; ci < order.length; ci++) {
    if (owner.every((o) => o !== -1)) break;
    place(ci, new Set());
  }
  return owner.map((o) => (o === -1 ? null : order[o].id));
}

/**
 * Presentation pass for a FIXED set of starters: give every player the most specific slot that still lets everybody else be seated
 * (fewest-options players first), so a center shows at C rather than UTIL. Returns slot index -> player id.
 */
export function refineSlots(starters: readonly SlotCandidate[], slots: readonly string[]): (string | null)[] {
  const options = (c: SlotCandidate) => slots.filter((s) => slotAccepts(s, c.positions)).length;
  const order = [...starters].sort((a, b) => options(a) - options(b) || b.value - a.value || a.id.localeCompare(b.id));
  const chosen: (string | null)[] = slots.map(() => null);
  const feasible = (rest: readonly SlotCandidate[], free: number[]): boolean => {
    const owner = new Map<number, number>();
    const place = (ci: number, seen: Set<number>): boolean => {
      for (const si of free) {
        if (seen.has(si) || !slotAccepts(slots[si], rest[ci].positions)) continue;
        seen.add(si);
        const o = owner.get(si);
        if (o === undefined || place(o, seen)) {
          owner.set(si, ci);
          return true;
        }
      }
      return false;
    };
    return rest.every((_, ci) => place(ci, new Set()));
  };
  const pref = (s: string) => BREADTH[s] ?? 3;
  for (let i = 0; i < order.length; i++) {
    const rest = order.slice(i + 1);
    const free = slots.map((_, si) => si).filter((si) => chosen[si] === null);
    const tries = free.filter((si) => slotAccepts(slots[si], order[i].positions)).sort((a, b) => pref(slots[a]) - pref(slots[b]) || a - b);
    const pick = tries.find((si) => feasible(rest, free.filter((x) => x !== si)));
    if (pick === undefined) return assignSlots(starters, slots); // cannot happen for a feasible set; keep the plain matching
    chosen[pick] = order[i].id;
  }
  return chosen;
}

/** Position groups used to find a like-for-like replacement (G, F, C buckets). */
export function positionGroups(positions: readonly Position[]): Set<"G" | "F" | "C"> {
  const g = new Set<"G" | "F" | "C">();
  for (const p of positions) g.add(p === "PG" || p === "SG" ? "G" : p === "SF" || p === "PF" ? "F" : "C");
  return g;
}

export const positionsLabel = (positions: readonly Position[]): string => positions.join("/");
