import { describe, it, expect } from "vitest";
import {
  pickOwner, userPicks, nextUserPick, nextUserPickAfter, isUserPick, totalPicks,
} from "@/engine/draft/snake";

describe("snake", () => {
  it("14 teams / slot 13 matches spec", () => {
    expect(userPicks(14, 13, 13)).toEqual([13, 16, 41, 44, 69, 72, 97, 100, 125, 128, 153, 156, 181]);
  });
  it("pickOwner basics", () => {
    expect(pickOwner(1, 14)).toEqual({ round: 1, teamSlot: 1 });
    expect(pickOwner(14, 14)).toEqual({ round: 1, teamSlot: 14 });
    expect(pickOwner(15, 14)).toEqual({ round: 2, teamSlot: 14 });
    expect(pickOwner(28, 14)).toEqual({ round: 2, teamSlot: 1 });
    expect(pickOwner(29, 14)).toEqual({ round: 3, teamSlot: 1 });
    expect(pickOwner(16, 14)).toEqual({ round: 2, teamSlot: 13 });
  });
  for (const n of [2, 10, 12, 14]) {
    it(`invariants for N=${n}`, () => {
      const rounds = 7;
      expect(totalPicks(n, rounds)).toBe(n * rounds);
      for (let r = 1; r <= rounds; r++) {
        const slots = new Set<number>();
        for (let p = (r - 1) * n + 1; p <= r * n; p++) {
          const o = pickOwner(p, n);
          expect(o.round).toBe(r);
          slots.add(o.teamSlot);
        }
        expect(slots.size).toBe(n);
      }
      for (let s = 1; s <= n; s++) {
        const ups = userPicks(n, s, rounds);
        expect(ups).toHaveLength(rounds);
        ups.forEach((p, i) => {
          expect(pickOwner(p, n)).toEqual({ round: i + 1, teamSlot: s });
          expect(isUserPick(p, n, s)).toBe(true);
        });
        let count = 0;
        for (let p = 1; p <= n * rounds; p++) if (isUserPick(p, n, s)) count++;
        expect(count).toBe(rounds);
      }
    });
  }
  it("nextUserPick / nextUserPickAfter", () => {
    expect(nextUserPick(1, 14, 13, 13)).toBe(13);
    expect(nextUserPick(13, 14, 13, 13)).toBe(13);
    expect(nextUserPick(14, 14, 13, 13)).toBe(16);
    expect(nextUserPickAfter(13, 14, 13, 13)).toBe(16);
    expect(nextUserPickAfter(12, 14, 13, 13)).toBe(13);
    expect(nextUserPick(181, 14, 13, 13)).toBe(181);
    expect(nextUserPick(182, 14, 13, 13)).toBeNull();
    expect(nextUserPickAfter(181, 14, 13, 13)).toBeNull();
  });
  it("throws on invalid input", () => {
    expect(() => pickOwner(0, 12)).toThrow();
    expect(() => pickOwner(1.5, 12)).toThrow();
    expect(() => pickOwner(1, 1)).toThrow();
    expect(() => userPicks(12, 0, 5)).toThrow();
    expect(() => userPicks(12, 13, 5)).toThrow();
    expect(() => userPicks(12, 3, -1)).toThrow();
    expect(() => isUserPick(5, 12, 20)).toThrow();
    expect(() => nextUserPick(0, 12, 3, 5)).toThrow();
  });
});
