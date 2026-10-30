import { describe, expect, it } from "vitest";
import { rankMoves, isLongTermOut } from "@/engine/season/addDrop";
import { buildModel, curVecOf, type MatchupData } from "@/engine/season/evaluate";
import { catWinProbs, distOf, matchWinProb } from "@/engine/season/matchup";
import { buildAlerts, computeBoosts } from "@/engine/season/newsRules";
import { gamesInRange, weekEndOf } from "@/engine/season/schedule";
import { makeLeague, mkPlayer } from "./season-fixtures";
import type { SeasonPlayer } from "@/engine/season/types";

const input = (fx: ReturnType<typeof makeLeague>, over: Partial<Parameters<typeof rankMoves>[0]> = {}) => ({
  ctx: fx.ctx, players: fx.players, entries: fx.entries, opponents: fx.opponents, freeAgentIds: fx.freeAgentIds, matchup: null, schedule: { lastDate: fx.schedule.lastDate }, addsRemaining: 4, ...over,
});
const userPlayers = (fx: ReturnType<typeof makeLeague>) => fx.entries.map((e) => fx.players.get(e.playerId)!);

describe("win probability model", () => {
  it("is monotonic: a better roster never lowers this week's or the rest-of-season win probability", () => {
    const fx = makeLeague({ userScale: 1 });
    const model = buildModel(fx.ctx, fx.opponents, null, { lastDate: fx.schedule.lastDate });
    const wins: number[] = [];
    const ros: number[] = [];
    for (const k of [0.7, 0.85, 1, 1.15, 1.3]) {
      const roster = userPlayers(fx).map((p) => ({ ...p, line: p.line.map((x, i) => (i === 10 ? x : x * k)) }));
      wins.push(model.week(roster).winProb);
      ros.push(model.ros(roster).winProb);
    }
    for (let i = 1; i < wins.length; i++) {
      expect(wins[i]).toBeGreaterThanOrEqual(wins[i - 1] - 1e-9);
      expect(ros[i]).toBeGreaterThanOrEqual(ros[i - 1] - 1e-9);
    }
    expect(ros[4]).toBeGreaterThan(ros[0] + 0.2);
  });
  it("banked category totals move the odds: leading everywhere late in the week ~ certain, trailing ~ lost", () => {
    const fx = makeLeague({ today: "2026-11-08" }); // Sunday: one day left
    const mkM = (k: number): MatchupData => ({
      week: 5, capturedAt: "2026-11-08T12:00:00Z",
      you: { name: "Me", cats: { fgPct: 0.5 * k, ftPct: 0.8 * k, threePm: 60 * k, pts: 700 * k, reb: 300 * k, ast: 200 * k, stl: 50 * k, blk: 30 * k, tov: 90 / k } },
      opp: { name: "Team 2", cats: { fgPct: 0.45, ftPct: 0.75, threePm: 50, pts: 600, reb: 250, ast: 170, stl: 40, blk: 25, tov: 100 } },
    });
    const ahead = buildModel(fx.ctx, fx.opponents, mkM(1.3), null).week(userPlayers(fx));
    const behind = buildModel(fx.ctx, fx.opponents, mkM(0.7), null).week(userPlayers(fx));
    expect(ahead.winProb).toBeGreaterThan(0.97);
    expect(behind.winProb).toBeLessThan(0.03);
    expect(ahead.catP.every((p) => p > 0.9)).toBe(true);
  });
  it("identifies this week's opponent by team name and uses his roster", () => {
    const fx = makeLeague();
    const m: MatchupData = { week: 2, capturedAt: "2026-11-03T12:00:00Z", you: { name: "Me", cats: {} }, opp: { name: "team 5", cats: {} } };
    expect(buildModel(fx.ctx, fx.opponents, m, null).opponentResolved).toBe("Team 5");
    expect(buildModel(fx.ctx, fx.opponents, { ...m, opp: { name: "Nobody", cats: {} } }, null).opponentResolved).toBeNull();
  });
  it("curVecOf estimates attempts from percentages and volume; Poisson-binomial helper is sane", () => {
    const v = curVecOf({ name: "x", cats: { fgPct: 0.5, ftPct: 0.8, pts: 10 } }, 0.5, [0, 100, 0, 40, 0, 0, 0, 0, 0, 0, 0])!;
    expect(v[1]).toBeCloseTo(50);
    expect(v[0]).toBeCloseTo(25);
    expect(v[3]).toBeCloseTo(20);
    expect(matchWinProb([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).toBeCloseTo(0.5, 6);
    expect(matchWinProb([1, 1, 1, 1, 1, 0, 0, 0, 0])).toBeCloseTo(1, 9);
    const a = distOf(null, { totals: [50, 100, 30, 40, 10, 150, 50, 30, 10, 6, 20], playerGames: 35 });
    expect(catWinProbs(a, a).every((p) => Math.abs(p - 0.5) < 1e-6)).toBe(true);
  });
});

describe("rankMoves", () => {
  it("a clearly better free agent is suggested, labelled, with positive deltas and reasons", () => {
    const fx = makeLeague();
    const star = mkPlayer("fa-star", { team: fx.players.get("t0p0")!.team, pos: ["PG"], scale: 1.6, z: { PTS: 3, REB: 2, AST: 2, STL: 2, BLK: 1 } });
    fx.players.set(star.id, star);
    const r = rankMoves(input(fx, { freeAgentIds: [...fx.freeAgentIds, star.id] }));
    expect(r.moves.length).toBeGreaterThan(0);
    const top = r.moves[0];
    expect(top.add.playerId).toBe("fa-star");
    expect(top.dWeek).toBeGreaterThan(0.01);
    expect(top.dRos).toBeGreaterThan(0.01);
    expect(["season", "injury"]).toContain(top.kind);
    expect(top.drop).not.toBeNull();
    expect(top.reasons.join(" ")).toMatch(/pp/);
    expect(r.moves.map((m) => m.score)).toEqual([...r.moves.map((m) => m.score)].sort((a, b) => b - a));
    expect(new Set(r.moves.map((m) => m.add.playerId)).size).toBe(r.moves.length);
  });
  it("several good adds for the same cheapest drop are all listed (one drop may fill half the list)", () => {
    const fx = makeLeague();
    const team = fx.players.get("t0p0")!.team;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const fa = mkPlayer(`fa-good${i}`, { team, pos: ["PG"], scale: 1.5 - i * 0.03, z: { PTS: 3, REB: 2, AST: 2, STL: 2, BLK: 1 } });
      fx.players.set(fa.id, fa);
      ids.push(fa.id);
    }
    const r = rankMoves(input(fx, { freeAgentIds: [...fx.freeAgentIds, ...ids], limit: 8 }));
    const byDrop = new Map<string, number>();
    for (const m of r.moves) byDrop.set(m.drop?.playerId ?? "-", (byDrop.get(m.drop?.playerId ?? "-") ?? 0) + 1);
    expect(Math.max(...byDrop.values())).toBeGreaterThan(2);
    expect(Math.max(...byDrop.values())).toBeLessThanOrEqual(4);
    expect(r.moves.filter((m) => m.add.playerId.startsWith("fa-good")).length).toBeGreaterThan(2);
  });
  it("junk free agents produce no suggestions", () => {
    const fx = makeLeague({ faCount: 10 });
    for (const id of fx.freeAgentIds) fx.players.set(id, { ...fx.players.get(id)!, line: fx.players.get(id)!.line.map((x) => x * 0.2), z: { ...fx.players.get(id)!.z, PTS: -4 }, nineCat: -9 });
    expect(rankMoves(input(fx)).moves).toEqual([]);
  });
  it("never drops one of the 8 best players (by value) unless he is injured long-term", () => {
    const fx = makeLeague();
    const star = mkPlayer("fa-star", { pos: ["C"], scale: 1.8, z: { PTS: 4, REB: 3, BLK: 3 } });
    fx.players.set(star.id, star);
    const r = rankMoves(input(fx, { freeAgentIds: [star.id, ...fx.freeAgentIds] }));
    const mine = userPlayers(fx).sort((a, b) => b.nineCat * Math.max(0.3, b.avail) - a.nineCat * Math.max(0.3, a.avail));
    const protectedIds = new Set(mine.slice(0, 8).map((p) => p.id));
    for (const m of r.moves) if (m.drop) expect(protectedIds.has(m.drop.playerId)).toBe(false);
    expect(r.droppable.every((d) => !protectedIds.has(d.playerId))).toBe(true);
  });
  it("respects the weekly add limit: 0 left blocks every move, 1 left warns on streams", () => {
    const fx = makeLeague();
    const star = mkPlayer("fa-star", { pos: ["PG"], scale: 1.6, z: { PTS: 3, REB: 2 } });
    fx.players.set(star.id, star);
    const none = rankMoves(input(fx, { freeAgentIds: [star.id], addsRemaining: 0 }));
    expect(none.moves.length).toBeGreaterThan(0);
    expect(none.moves.every((m) => /No adds left/.test(m.blocked ?? ""))).toBe(true);
    const some = rankMoves(input(fx, { freeAgentIds: [star.id], addsRemaining: 3 }));
    expect(some.moves.every((m) => !m.blocked)).toBe(true);
  });
  it("streaming: among equal free agents the one with more games left this week gains more this week", () => {
    const fx = makeLeague({ today: "2026-11-02" }); // Monday
    const sch = fx.schedule.teams;
    const end = weekEndOf(fx.ctx.today);
    const byGames = Object.keys(sch).sort((a, b) => gamesInRange(sch, b, fx.ctx.today, end) - gamesInRange(sch, a, fx.ctx.today, end));
    const hi = byGames[0];
    const lo = byGames[byGames.length - 1];
    expect(gamesInRange(sch, hi, fx.ctx.today, end)).toBeGreaterThan(gamesInRange(sch, lo, fx.ctx.today, end));
    const a = mkPlayer("fa-many", { team: hi, pos: ["SF"], scale: 1.3, z: { PTS: 2, STL: 1 } });
    const b = mkPlayer("fa-few", { team: lo, pos: ["SF"], scale: 1.3, z: { PTS: 2, STL: 1 } });
    fx.players.set(a.id, a);
    fx.players.set(b.id, b);
    const r = rankMoves(input(fx, { freeAgentIds: [a.id, b.id], limit: 20 }));
    const ma = r.moves.find((m) => m.add.playerId === "fa-many");
    const mb = r.moves.find((m) => m.add.playerId === "fa-few");
    expect(ma).toBeDefined();
    expect(ma!.add.games).toBeGreaterThan(mb ? mb.add.games : 0);
    if (mb) expect(ma!.dWeek).toBeGreaterThan(mb.dWeek);
  });
  it("injured starter with a free IL slot: IL him and add a replacement (no drop); IL full: drop the injured player", () => {
    const fx = makeLeague();
    const star = fx.players.get("t0p4")!; // a C
    fx.players.set(star.id, { ...star, injury: { flag: "ofs", tag: "INJ", injury: "Achilles" } });
    const rep = mkPlayer("fa-c", { pos: ["C"], scale: 1.1, z: { REB: 1, BLK: 1 } });
    fx.players.set(rep.id, rep);
    const free = rankMoves(input(fx, { freeAgentIds: [rep.id] }));
    const mv = free.moves.find((m) => m.add.playerId === "fa-c")!;
    expect(mv.kind).toBe("injury");
    expect(mv.label).toBe("Injury replacement (C)");
    expect(mv.ilMove?.playerId).toBe("t0p4");
    expect(mv.drop).toBeNull();
    const ilFull = [...fx.entries, { playerId: "t1p0", slot: "IL", status: "il" as const }, { playerId: "t1p1", slot: "IL", status: "il" as const }];
    const full = rankMoves(input(fx, { entries: ilFull, freeAgentIds: [rep.id] }));
    const mv2 = full.moves.find((m) => m.add.playerId === "fa-c")!;
    expect(mv2.ilMove).toBeNull();
    expect(mv2.drop?.playerId).toBe("t0p4");
    expect(mv2.news.join(" ")).toMatch(/IL slots are full/);
  });
  it("only offers free agents who are not rostered and not out for the season", () => {
    const fx = makeLeague({ faCount: 6 });
    fx.players.set("fa0", { ...fx.players.get("fa0")!, injury: { flag: "ofs" }, line: fx.players.get("fa0")!.line.map((x) => x * 3) });
    const r = rankMoves(input(fx, { freeAgentIds: [...fx.freeAgentIds, "t3p3"] })); // t3p3 sits on an opponent's roster
    expect(r.moves.some((m) => m.add.playerId === "fa0" || m.add.playerId === "t3p3")).toBe(false);
  });
  it("isLongTermOut thresholds", () => {
    const today = "2026-11-03";
    expect(isLongTermOut(mkPlayer("a", { injury: { flag: "out", estReturn: "2026-11-08" } }), today)).toBe(false);
    expect(isLongTermOut(mkPlayer("a", { injury: { flag: "out", estReturn: "2026-12-08" } }), today)).toBe(true);
    expect(isLongTermOut(mkPlayer("a", { injury: { flag: "out" } }), today)).toBe(true);
    expect(isLongTermOut(mkPlayer("a", { injury: { flag: "gtd" } }), today)).toBe(false);
  });
});

describe("news -> actions", () => {
  const today = "2026-11-03";
  it("teammate-of-injured-starter bump: same position group, same team, until the return date", () => {
    const starter = mkPlayer("starter", { team: "LAL", pos: ["C"], minutes: 32, injury: { flag: "out", injury: "Foot", estReturn: "2026-11-20" } });
    const backup = mkPlayer("backup", { team: "LAL", pos: ["C", "PF"], minutes: 14 });
    const guard = mkPlayer("guard", { team: "LAL", pos: ["PG"], minutes: 30 });
    const other = mkPlayer("other", { team: "BOS", pos: ["C"], minutes: 14 });
    const bench = mkPlayer("bench-out", { team: "DEN", pos: ["C"], minutes: 10, injury: { flag: "out" } });
    const dwarf = mkPlayer("dwarf", { team: "DEN", pos: ["C"], minutes: 12 });
    const b = computeBoosts([starter, backup, guard, other, bench, dwarf], today);
    expect(b.get("backup")!.factor).toBeGreaterThan(1.1);
    expect(b.get("backup")!.until).toBe("2026-11-20");
    expect(b.get("backup")!.reason).toMatch(/starter out \(Foot\)/i);
    expect(b.has("guard")).toBe(false);
    expect(b.has("other")).toBe(false);
    expect(b.has("dwarf")).toBe(false); // the absent player played < 22 min
  });
  it("a boosted free agent is worth more in the add/drop model", () => {
    const fx = makeLeague({ faCount: 0 });
    const base = mkPlayer("fa-b", { team: "LAL", pos: ["C"], scale: 1.0, z: { REB: 1 } });
    const boosted: SeasonPlayer = { ...base, id: "fa-boost", boost: { factor: 1.3, until: null, reason: "minutes up: X out" } };
    fx.players.set(base.id, base);
    fx.players.set(boosted.id, boosted);
    const r = rankMoves(input(fx, { freeAgentIds: [base.id, boosted.id], limit: 20 }));
    const get = (id: string) => r.moves.find((m) => m.add.playerId === id)?.score ?? -1;
    expect(get("fa-boost")).toBeGreaterThan(get("fa-b"));
  });
  it("alerts: IL move + replacement, activate from IL, minutes-up free agents", () => {
    const hurt = mkPlayer("hurt", { pos: ["C"], injury: { flag: "ofs", tag: "INJ", injury: "ACL" } });
    const back = mkPlayer("back", { pos: ["SF"], injury: { flag: "healthy" } });
    const fa = mkPlayer("fa-bump", { team: "LAL", pos: ["C"] });
    fa.boost = { factor: 1.2, until: null, reason: "minutes up: Y out (Knee)" };
    const players = new Map([hurt, back, fa].map((p) => [p.id, p]));
    const alerts = buildAlerts({
      today, players, ilSlots: 2, freeAgentIds: ["fa-bump"], droppable: [{ playerId: "w", name: "WORST", team: "BOS", positions: "SF" }],
      entries: [{ playerId: "hurt", slot: "C", status: "active" }, { playerId: "back", slot: "IL", status: "il" }],
      moves: [{ kind: "injury", label: "Injury replacement (C)", add: { playerId: "r", name: "Repl", team: "BOS", positions: "C", games: 3, pctOwned: null }, drop: null, ilMove: { playerId: "hurt", name: "HURT", team: "BOS", positions: "C" }, dWeek: 0.05, dRos: 0.02, score: 0.1, reasons: [], news: [] }],
    });
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["il-move", "activate", "fa-bump"]));
    expect(alerts.find((a) => a.kind === "il-move")!.detail).toMatch(/Repl/);
    expect(alerts.find((a) => a.kind === "activate")!.detail).toMatch(/WORST/);
    expect(alerts.find((a) => a.kind === "fa-bump")!.title).toMatch(/FA FA-BUMP/);
  });
});

