import { describe, expect, it } from "vitest";
import { evaluateTrade, findTrades, tradeContext, type TradeTeam } from "@/engine/season/trades";
import { makeLeague } from "./season-fixtures";

function setup() {
  const fx = makeLeague();
  const user: TradeTeam = { slot: 1, name: "Me", players: fx.entries.map((e) => fx.players.get(e.playerId)!) };
  const teams: TradeTeam[] = [user, ...fx.opponents];
  const tc = tradeContext(fx.ctx, teams, { lastDate: fx.schedule.lastDate });
  const freeAgents = fx.freeAgentIds.map((id) => fx.players.get(id)!);
  return { fx, tc, teams, user, freeAgents };
}
const best = (t: TradeTeam) => [...t.players].sort((a, b) => b.nineCat * b.avail - a.nineCat * a.avail)[0];
const worst = (t: TradeTeam) => [...t.players].sort((a, b) => a.nineCat * a.avail - b.nineCat * b.avail)[0];

describe("trades", () => {
  it("evaluateTrade: giving your best player for their worst hurts you and helps them", () => {
    const { tc, teams, user } = setup();
    const them = teams[1];
    const e = evaluateTrade(tc, 1, [best(user)], them.slot, [worst(them)]);
    expect(e.a.dRos).toBeLessThan(0);
    expect(e.b.dRos).toBeGreaterThan(0);
    expect(e.a.gives[0].playerId).toBe(best(user).id);
    expect(e.a.gets[0].playerId).toBe(worst(them).id);
    expect(e.b.gets[0].playerId).toBe(best(user).id);
    expect(e.a.after - e.a.before).toBeCloseTo(e.a.dRos, 10);
    // the reverse trade mirrors the signs
    const r = evaluateTrade(tc, them.slot, [worst(them)], 1, [best(user)]);
    expect(r.a.dRos).toBeGreaterThan(0);
    expect(r.b.dRos).toBeLessThan(0);
  });
  it("2-for-1 keeps roster sizes: the side getting two drops one, the other adds a free agent", () => {
    const { tc, teams, user, freeAgents } = setup();
    const them = teams[2];
    const [g1, g2] = [...user.players].sort((a, b) => a.nineCat - b.nineCat).slice(5, 7);
    const e = evaluateTrade(tc, 1, [g1, g2], them.slot, [best(them)], freeAgents);
    expect(e.a.adds).not.toBeNull();
    expect(e.a.drops).toBeNull();
    expect(e.b.drops).not.toBeNull();
    expect([g1.id, g2.id]).not.toContain(e.b.drops!.playerId);
    expect(freeAgents.map((p) => p.id)).toContain(e.a.adds!.playerId);
  });
  it("findTrades: only trades both sides gain from, best for you first, diversified, within budget", () => {
    const { tc, freeAgents } = setup();
    const r = findTrades({ tc, userSlot: 1, freeAgents, limit: 8, maxEvaluations: 600 });
    expect(r.evaluated).toBeLessThanOrEqual(600);
    for (const i of r.ideas) {
      expect(i.a.dRos).toBeGreaterThanOrEqual(0.005);
      expect(i.b.dRos).toBeGreaterThanOrEqual(0.001);
      expect(i.a.slot).toBe(1);
    }
    expect(r.ideas.map((i) => i.score)).toEqual([...r.ideas.map((i) => i.score)].sort((a, b) => b - a));
    const perTeam = new Map<number, number>();
    for (const i of r.ideas) perTeam.set(i.b.slot, (perTeam.get(i.b.slot) ?? 0) + 1);
    expect(Math.max(0, ...perTeam.values())).toBeLessThanOrEqual(2);
  });
  it("findTrades never offers long-term injured players", () => {
    const { fx, tc, user, freeAgents } = setup();
    const hurt = { ...user.players[3], injury: { flag: "out" as const, estReturn: "2027-03-01" } };
    user.players[3] = hurt;
    fx.players.set(hurt.id, hurt);
    const r = findTrades({ tc: tradeContext(fx.ctx, tc.teams, tc.schedule), userSlot: 1, freeAgents, maxEvaluations: 400 });
    expect(r.ideas.flatMap((i) => i.a.gives.map((p) => p.playerId))).not.toContain(hurt.id);
  });
});
