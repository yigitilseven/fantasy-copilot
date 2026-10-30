import { describe, expect, it } from "vitest";
import { pickForOpponent } from "@/engine/draft/opponent";
import { estimateStandings } from "@/engine/draft/standings";
import { createRng } from "@/engine/draft/rng";
import type { PlayerValuation, Position, SimPlayer } from "@/types";
import { CATEGORIES } from "@/types";

const pool = (n: number, pos: Position[] = ["SF"]): SimPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, adp: i + 1, adpStdDev: 2 + i * 0.1, value: 5, positions: pos }));

describe("pickForOpponent", () => {
  it("is deterministic given the rng seed", () => {
    const a = pickForOpponent(pool(100), createRng(5));
    const b = pickForOpponent(pool(100), createRng(5));
    expect(a).toBe(b);
  });
  it("returns null for empty pool", () => {
    expect(pickForOpponent([], createRng(1))).toBeNull();
  });
  it("only picks from the available list", () => {
    const avail = pool(100).slice(40);
    const ids = new Set(avail.map((p) => p.id));
    for (let s = 0; s < 200; s++) expect(ids.has(pickForOpponent(avail, createRng(s))!)).toBe(true);
  });
  it("picks a top-ADP player most of the time", () => {
    let top = 0;
    const n = 500;
    for (let s = 0; s < n; s++) {
      const id = pickForOpponent(pool(100), createRng(s))!;
      if (Number(id.slice(1)) <= 5) top++;
    }
    expect(top / n).toBeGreaterThan(0.8);
  });
  it("de-prioritises pure C once the team has 3, and guard-only once it has 4", () => {
    const players: SimPlayer[] = [
      { id: "c", adp: 1, adpStdDev: 0.5, value: 5, positions: ["C"] },
      { id: "g", adp: 2, adpStdDev: 0.5, value: 5, positions: ["PG", "SG"] },
      { id: "f", adp: 3, adpStdDev: 0.5, value: 5, positions: ["SF"] },
    ];
    const cs: Position[][] = [["C"], ["C"], ["C"]];
    const gs: Position[][] = [["PG"], ["SG"], ["PG", "SG"], ["PG"]];
    expect(pickForOpponent(players, createRng(1))).toBe("c");
    expect(pickForOpponent(players, createRng(1), { teamRosterPositions: cs })).toBe("g");
    expect(pickForOpponent(players.slice(1), createRng(1), { teamRosterPositions: gs })).toBe("f");
    // C/PF is not pure C, not penalised
    const cpf = [{ ...players[0], positions: ["C", "PF"] as Position[] }, ...players.slice(1)];
    expect(pickForOpponent(cpf, createRng(1), { teamRosterPositions: cs })).toBe("c");
  });
});

describe("estimateStandings", () => {
  it("ranks and H2H from z totals", () => {
    const val = (id: string, v: number): [string, PlayerValuation] => [
      id, { playerId: id, nineCat: v * 9, z: Object.fromEntries(CATEGORIES.map((c) => [c, v])) as PlayerValuation["z"] },
    ];
    const valuations = Object.fromEntries([val("a", 3), val("b", 2), val("c", 1)]);
    const mk = (pick: number, teamSlot: number, playerId: string) => ({ pick, round: 1, teamSlot, playerId, source: "manual" as const, timestamp: "" });
    const s = estimateStandings([mk(1, 1, "a"), mk(2, 2, "b"), mk(3, 3, "c")], 3, 2, valuations);
    expect(s.ranks["PTS"]).toBe(2);
    expect(s.h2h.find((h) => h.slot === 1)).toMatchObject({ won: 0, lost: 9 });
    expect(s.h2h.find((h) => h.slot === 3)).toMatchObject({ won: 9, lost: 0 });
    expect(s.winRate).toBeCloseTo(0.5);
  });
});
