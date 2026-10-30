import { describe, expect, it } from "vitest";
import { assignSlots, slotAccepts } from "@/engine/season/slots";
import { planDay } from "@/engine/season/lineup";
import { leverageOf, leverageWeights } from "@/engine/season/matchup";
import { playProb } from "@/engine/season/projection";
import { projectWindow } from "@/engine/season/window";
import type { RosterEntry, SeasonPlayer } from "@/engine/season/types";
import { everyDay, mkCtx, mkPlayer } from "./season-fixtures";

const DAY = "2026-10-21";
const entries = (ids: string[], status: RosterEntry["status"] = "active"): RosterEntry[] => ids.map((playerId) => ({ playerId, slot: null, status }));
const mapOf = (ps: SeasonPlayer[]) => new Map(ps.map((p) => [p.id, p]));

describe("slot eligibility + assignment", () => {
  it("G/F/UTIL/C rules", () => {
    expect(slotAccepts("G", ["PG"])).toBe(true);
    expect(slotAccepts("G", ["SF", "PF"])).toBe(false);
    expect(slotAccepts("F", ["SF"])).toBe(true);
    expect(slotAccepts("C", ["PF"])).toBe(false);
    expect(slotAccepts("UTIL", ["C"])).toBe(true);
    expect(slotAccepts("BN", ["C"])).toBe(false);
  });
  it("uses an augmenting path: the flexible player moves so the specialist fits (maximum weight under eligibility)", () => {
    // Slots: PG, C. The "pg/c" player is best but must give way to the only other PG, who can only take PG; the C-only player needs C.
    const placed = assignSlots(
      [
        { id: "flex", positions: ["PG", "C"], value: 10 },
        { id: "pg", positions: ["PG"], value: 9 },
        { id: "c", positions: ["C"], value: 8 },
      ],
      ["PG", "C"],
    );
    expect(placed).toEqual(["pg", "flex"]); // flex plays C so that the higher of the two PGs-only... total 19 beats flex@PG + c@C = 18
  });
  it("never puts a player in a slot he cannot fill; extra players are left out; empty slots stay null", () => {
    const placed = assignSlots([{ id: "a", positions: ["SF"], value: 1 }, { id: "b", positions: ["SF"], value: 2 }], ["PG", "SF"]);
    expect(placed).toEqual([null, "b"]);
  });
});

describe("planDay", () => {
  const sched = everyDay(["BOS", "LAL", "DEN", "MIA"], "2026-10-19", "2026-10-26");

  it("fills 10 slots by value under eligibility and benches the rest with a reason", () => {
    const ps = [
      mkPlayer("pg1", { pos: ["PG"], z: { AST: 3 } }), mkPlayer("pg2", { pos: ["PG"], z: { AST: 2 } }), mkPlayer("sg1", { pos: ["SG"], z: { "3PM": 2 } }),
      mkPlayer("sf1", { pos: ["SF"], z: { PTS: 2 } }), mkPlayer("pf1", { pos: ["PF"], z: { REB: 2 } }), mkPlayer("c1", { pos: ["C"], z: { BLK: 3 } }), mkPlayer("c2", { pos: ["C"], z: { BLK: 2 } }),
      mkPlayer("c3", { pos: ["C"], z: { BLK: 1 } }), mkPlayer("sf2", { pos: ["SF"], z: { STL: 1 } }), mkPlayer("pf2", { pos: ["PF"], z: { REB: 1 } }), mkPlayer("sg2", { pos: ["SG"], z: { STL: 1 } }),
      mkPlayer("sg3", { pos: ["SG"], z: { TO: -3 } }), mkPlayer("sf3", { pos: ["SF"], z: { TO: -4 } }),
    ];
    const r = planDay(entries(ps.map((p) => p.id)), mapOf(ps), mkCtx(DAY, sched));
    expect(r.starters).toHaveLength(10);
    const bySlot = (s: string) => r.starters.filter((x) => x.slot === s).map((x) => x.playerId);
    expect(bySlot("C").sort()).toEqual(["c1", "c2"]);
    for (const s of r.starters) expect(slotAccepts(s.slot, ps.find((p) => p.id === s.playerId)!.positions)).toBe(true);
    expect(r.starters.map((s) => s.playerId)).not.toContain("sf3");
    expect(r.bench.map((b) => b.playerId)).toEqual(expect.arrayContaining(["sf3", "sg3"]));
    expect(r.bench.every((b) => b.reason.length > 5)).toBe(true);
    expect(r.starters.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("players without a game sit; out players sit; nothing is started for an empty slot", () => {
    const ps = [mkPlayer("a", { team: "BOS", pos: ["PG"] }), mkPlayer("b", { team: "NOP", pos: ["SG"] }), mkPlayer("c", { team: "LAL", pos: ["C"], injury: { flag: "out", injury: "Knee", estReturn: "2026-11-05" } })];
    const r = planDay(entries(["a", "b", "c"]), mapOf(ps), mkCtx(DAY, sched));
    expect(r.starters.map((s) => s.playerId)).toEqual(["a"]);
    expect(r.bench.find((b) => b.playerId === "b")!.reason).toBe("No game today");
    expect(r.bench.find((b) => b.playerId === "c")!.reason).toMatch(/Out \(Knee\), back 2026-11-05/);
    expect(r.emptySlots).toHaveLength(9);
  });

  it("injured player: suggests IL while a slot is free, says so when IL is full", () => {
    const hurt = mkPlayer("hurt", { pos: ["C"], injury: { flag: "out", injury: "Achilles", estReturn: "2026-12-01", tag: "INJ" } });
    const ok = mkPlayer("ok");
    const free = planDay(entries(["hurt", "ok"]), mapOf([hurt, ok]), mkCtx(DAY, sched));
    expect(free.ilMoves).toEqual([expect.objectContaining({ playerId: "hurt", ilSlotFree: true, reason: expect.stringContaining("to IL") })]);
    const il1 = mkPlayer("il1", { injury: { flag: "ofs", tag: "INJ" } });
    const il2 = mkPlayer("il2", { injury: { flag: "ofs", tag: "INJ" } });
    const full = planDay([...entries(["hurt", "ok"]), ...entries(["il1", "il2"], "il")], mapOf([hurt, ok, il1, il2]), mkCtx(DAY, sched));
    expect(full.ilMoves[0].ilSlotFree).toBe(false);
    expect(full.il.map((x) => x.playerId)).toEqual(["il1", "il2"]);
  });

  it("GTD starts (flagged) when nobody better is available, and names the healthy bench option", () => {
    const gtd = mkPlayer("gtd", { pos: ["PG"], z: { AST: 4 }, injury: { flag: "gtd", injury: "Ankle" } });
    const alt = mkPlayer("alt", { pos: ["PG"], z: { AST: 1 } });
    const others = ["SG", "SF", "PF", "C", "C"].map((p, i) => mkPlayer(`o${i}`, { pos: [p as "SG"], z: { PTS: 2 } }));
    const extra = [mkPlayer("u1", { pos: ["SF"], z: { PTS: 1.5 } }), mkPlayer("u2", { pos: ["PF"], z: { PTS: 1.5 } }), mkPlayer("g2", { pos: ["SG"], z: { PTS: 1.5 } }), mkPlayer("v1", { pos: ["PG"], z: { PTS: 1.5 } }), mkPlayer("v2", { pos: ["SG"], z: { PTS: 1.5 } })];
    const ps = [gtd, alt, ...others, ...extra];
    const r = planDay(entries(ps.map((p) => p.id)), mapOf(ps), mkCtx(DAY, sched));
    const row = r.starters.find((s) => s.playerId === "gtd")!;
    expect(row.flags).toContain("GTD");
    expect(row.reason).toMatch(/bench option|no healthy bench/);
    expect(r.notes.join(" ")).toMatch(/game-time decision|alt|ALT/);
  });

  it("a healthy equal-value player beats a GTD one for the last slot", () => {
    const ps = ["PG", "SG", "SF", "PF", "C", "C", "SG", "SF", "PF"].map((p, i) => mkPlayer(`s${i}`, { pos: [p as "PG"], z: { PTS: 3 } }));
    const gtd = mkPlayer("gtd", { pos: ["SG"], z: { PTS: 1 }, injury: { flag: "gtd" } });
    const healthy = mkPlayer("healthy", { pos: ["SG"], z: { PTS: 1 } });
    const all = [...ps, gtd, healthy];
    const r = planDay(entries(all.map((p) => p.id)), mapOf(all), mkCtx(DAY, sched));
    const started = r.starters.map((s) => s.playerId);
    expect(started).toContain("healthy");
    expect(started).not.toContain("gtd");
  });

  it("leverage steers the last slot: a secured category loses weight, a toss-up category wins it", () => {
    const base = ["PG", "SG", "SF", "PF", "C", "C", "SG", "SF", "PF"].map((p, i) => mkPlayer(`s${i}`, { pos: [p as "PG"], z: { PTS: 3 } }));
    const blocker = mkPlayer("blocker", { pos: ["PF"], z: { BLK: 2.2 } });
    const scorer = mkPlayer("scorer", { pos: ["PF"], z: { PTS: 2.0 } });
    const all = [...base, blocker, scorer];
    const uniform = planDay(entries(all.map((p) => p.id)), mapOf(all), mkCtx(DAY, sched));
    expect(uniform.starters.map((s) => s.playerId)).toContain("blocker");
    expect(uniform.starters.map((s) => s.playerId)).not.toContain("scorer");
    // BLK already won (p = 0.97 -> weight 0.2+), PTS is a toss-up
    const p = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.97, 0.5];
    const lev = planDay(entries(all.map((x) => x.id)), mapOf(all), mkCtx(DAY, sched), leverageWeights(p));
    expect(lev.starters.map((s) => s.playerId)).toContain("scorer");
    expect(lev.starters.map((s) => s.playerId)).not.toContain("blocker");
  });

  it("changes vs the lineup currently set on Yahoo: START the bench player, SIT the one without a game", () => {
    const a = mkPlayer("a", { team: "BOS", pos: ["PG"], z: { PTS: 3 } });
    const b = mkPlayer("b", { team: "NOP", pos: ["SG"], z: { PTS: 3 } }); // no game
    const c = mkPlayer("c", { team: "LAL", pos: ["SG"], z: { PTS: 2 } });
    const es: RosterEntry[] = [{ playerId: "a", slot: "BN", status: "bench" }, { playerId: "b", slot: "SG", status: "active" }, { playerId: "c", slot: "BN", status: "bench" }];
    const r = planDay(es, mapOf([a, b, c]), mkCtx(DAY, sched));
    expect(r.changes.map((x) => `${x.type}:${x.playerId}`).sort()).toEqual(["sit:b", "start:a", "start:c"]);
  });

  it("without a schedule everybody is assumed to play and the lineup says so", () => {
    const r = planDay(entries(["x", "y"]), mapOf([mkPlayer("x"), mkPlayer("y", { pos: ["C"] })]), mkCtx(DAY, null));
    expect(r.starters).toHaveLength(2);
    expect(r.notes.join(" ")).toMatch(/schedule unavailable/i);
  });
});

describe("leverage + play probability", () => {
  it("leverage is 1 for toss-ups and shrinks for decided categories", () => {
    expect(leverageOf(0.5)).toBe(1);
    expect(leverageOf(0.25)).toBeCloseTo(1, 6);
    expect(leverageOf(0.75)).toBeCloseTo(1, 6);
    expect(leverageOf(0.05)).toBeLessThan(0.5);
    expect(leverageOf(0.99)).toBeLessThan(0.3);
    expect(leverageOf(0.9)).toBeGreaterThan(leverageOf(0.97));
  });
  it("injury rules for the chance to play", () => {
    const today = "2026-10-21";
    expect(playProb(mkPlayer("h"), today, today)).toBeCloseTo(0.9);
    expect(playProb(mkPlayer("o", { injury: { flag: "ofs" } }), "2027-02-01", today)).toBe(0);
    const out = mkPlayer("o", { injury: { flag: "out", estReturn: "2026-10-25" } });
    expect(playProb(out, "2026-10-24", today)).toBe(0);
    expect(playProb(out, "2026-10-25", today)).toBeCloseTo(0.9);
    expect(playProb(mkPlayer("u", { injury: { flag: "out" } }), "2026-10-30", today)).toBe(0); // unknown return: out for 14 days
    const g = mkPlayer("g", { injury: { flag: "gtd" } });
    expect(playProb(g, today, today)).toBeLessThan(0.9);
    expect(playProb(g, "2026-10-22", today)).toBeCloseTo(0.9);
  });
  it("projectWindow: more games in the window -> more production; slots cap overflow days", () => {
    const ps = Array.from({ length: 13 }, (_, i) => mkPlayer(`p${i}`, { pos: [(["PG", "SG", "SF", "PF", "C"] as const)[i % 5]] }));
    const all = everyDay(["BOS"], "2026-10-19", "2026-10-25");
    const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
    const a = projectWindow(ps, week, mkCtx(DAY, all));
    const b = projectWindow(ps, week.slice(0, 3), mkCtx(DAY, all));
    expect(a.totals[5]).toBeGreaterThan(b.totals[5] * 2);
    // all 13 play every day but only 10 slots: per-day starters cap at 10
    expect(a.playerGames).toBeLessThanOrEqual(10 * 7 * 0.9 + 1e-6);
  });
});
