import { describe, expect, it } from "vitest";
import { buildSeasonReport, renderReportText } from "@/engine/season/report";
import { makeLeague } from "./season-fixtures";

describe("buildSeasonReport", () => {
  const fx = makeLeague({ userScale: 1.1 });
  const teams = [{ slot: 1, name: "Me", isUser: true, entries: fx.entries }, ...fx.opponents.map((o) => ({ slot: o.slot, name: o.name, isUser: false, entries: o.players.map((p) => ({ playerId: p.id, slot: null, status: "active" as const })) }))];
  const r = buildSeasonReport({ ctx: fx.ctx, players: fx.players, teams, freeAgentIds: fx.freeAgentIds, faSource: "captured", matchup: null, schedule: { lastDate: fx.schedule.lastDate }, addsRemaining: 4, addsLimit: 4 });

  it("ranks the user in every category among all teams", () => {
    expect(r.teams).toHaveLength(14);
    expect(r.cats.map((c) => c.cat)).toEqual(["FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"]);
    for (const c of r.cats) expect(c.rank).toBeGreaterThanOrEqual(1);
    for (const c of r.cats) {
      if (c.rank <= 4) expect(c.label).toBe("strength");
      else if (c.rank > 10) expect(c.label).toBe("weakness");
      else expect(["swing", "neutral"]).toContain(c.label);
    }
    expect(r.teams.find((t) => t.isUser)!.ranks).toHaveLength(9);
  });
  it("a stronger roster is favoured in the head-to-head grid, sorted hardest first", () => {
    expect(r.h2h).toHaveLength(13);
    expect(r.avgWinProb).toBeGreaterThan(0.55);
    for (let i = 1; i < r.h2h.length; i++) expect(r.h2h[i].winProb).toBeGreaterThanOrEqual(r.h2h[i - 1].winProb);
    expect(r.teams.find((t) => t.isUser)!.powerRank).toBeLessThanOrEqual(3);
  });
  it("lists depth, drop candidates cheapest first and a plain-language summary", () => {
    expect(r.depth).toHaveLength(5);
    for (let i = 1; i < r.drops.length; i++) expect(r.drops[i].dWin).toBeLessThanOrEqual(r.drops[i - 1].dWin);
    expect(r.summary.length).toBeGreaterThanOrEqual(5);
    expect(renderReportText(r)).toContain("Head to head");
  });
});
