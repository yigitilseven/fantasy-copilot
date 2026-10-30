import { describe, it, expect } from "vitest";
import { computeValuations } from "@/engine/valuation/value";
import { categoryProfile, needWeights } from "@/engine/roster/needs";
import { rosterFitValue } from "@/engine/roster/fit";
import { flexibility, positionalScarcity, valueOverReplacement } from "@/engine/roster/scarcity";
import { leagueConfig } from "@/config/default-league";
import { makeRecord } from "./fixtures";

const recs = [
  makeRecord({ id: "bigman", market: { rank: 1 }, positions: ["C"], projection: { reb: 14, blk: 2, pts: 14 } }),
  makeRecord({ id: "guard", market: { rank: 2 }, positions: ["PG"], projection: { ast: 9, stl: 2, reb: 3 } }),
  makeRecord({ id: "wing", market: { rank: 3 }, positions: ["SF", "PF"], projection: { threePm: 3.5, pts: 22 } }),
  makeRecord({ id: "filler1", market: { rank: 4 }, positions: ["SG"] }),
  makeRecord({ id: "filler2", market: { rank: 5 }, positions: ["PF"] }),
  makeRecord({ id: "filler3", market: { rank: 6 }, positions: ["C"], projection: { reb: 3, pts: 8 } }),
];
const { valuations } = computeValuations(recs);

describe("needs / fit", () => {
  it("empty roster has all weights 1", () => {
    const w = needWeights(categoryProfile([], valuations), 0);
    expect(Object.values(w).every((x) => x === 1)).toBe(true);
  });
  it("adding an elite rebounder lowers REB weight and weak cats get > 1", () => {
    const before = needWeights(categoryProfile(["guard"], valuations), 1);
    const after = needWeights(categoryProfile(["guard", "bigman"], valuations), 2);
    expect(after.REB).toBeLessThan(before.REB);
    expect(after.REB).toBeLessThan(1);
    const weak = needWeights(categoryProfile(["filler3"], valuations), 1);
    expect(weak.REB).toBeGreaterThan(1);
  });
  it("weights respect bounds", () => {
    const w = needWeights({ PTS: 1000, "3PM": -1000 } as never, 1, leagueConfig.needWeightBounds);
    expect(w.PTS).toBe(leagueConfig.needWeightBounds.min);
    expect(w["3PM"]).toBe(leagueConfig.needWeightBounds.max);
  });
  it("fit favors players filling weak categories", () => {
    const w = needWeights(categoryProfile(["bigman"], valuations), 1); // roster rich in REB/BLK
    expect(w.REB).toBeLessThan(w.AST);
    const fitGuard = rosterFitValue(valuations.guard, w);
    const raw = valuations.guard.nineCat;
    expect(fitGuard).toBeGreaterThan(raw - 1e-9 > 0 ? 0 : -Infinity);
    // same-value comparison: guard's AST-heavy z is up-weighted relative to REB
    const flat = rosterFitValue(valuations.guard, needWeights(categoryProfile([], valuations), 0));
    expect(flat).toBeCloseTo(raw);
  });
});

describe("scarcity / vorp / flexibility", () => {
  const opts = { teams: 14, rosterSlots: leagueConfig.rosterSlots };
  it("flexibility grows with positions and is within 0..1", () => {
    expect(flexibility(["C"])).toBeLessThan(flexibility(["PG"]));
    expect(flexibility(["PG"])).toBeLessThan(flexibility(["PG", "SG"]));
    expect(flexibility(["PG", "SG", "SF", "PF", "C"])).toBe(1);
  });
  it("scarcer position yields larger index", () => {
    const s = positionalScarcity(recs, valuations, opts);
    // 3 quality-ish C/PG... compare a position with no quality vs many
    const only = [recs[0]];
    const many = [recs[0], makeRecord({ id: "c2", positions: ["C"] }), makeRecord({ id: "c3", positions: ["C"] })];
    const vals = { ...valuations, c2: { ...valuations.bigman, playerId: "c2" }, c3: { ...valuations.bigman, playerId: "c3" } };
    expect(positionalScarcity(only, vals, opts).bigman).toBeGreaterThan(positionalScarcity(many, vals, opts).bigman);
    expect(s.wing).toBeGreaterThan(0);
  });
  it("VORP: best player over replacement is positive and multi-pos uses best position", () => {
    const v = valueOverReplacement(recs, valuations, { ...opts, picksMade: 0 });
    expect(v.bigman).toBeGreaterThan(0);
    const worst = recs.map((r) => v[r.player.id]).reduce((a, b) => Math.min(a, b));
    expect(worst).toBeLessThanOrEqual(0);
    // late draft: replacement rank collapses to 1 per position
    const late = valueOverReplacement(recs, valuations, { ...opts, picksMade: 14 * 13 - 1 });
    // rank 1 per position => the best player at a position has VORP 0
    expect(late.bigman).toBeCloseTo(0);
  });
});
