import { describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { createDraft, getDraft, updateDraftStrategy } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import {
  applyStrategyPatch, defaultStrategy, makeStrategy, parseStrategy, projectionModeOf, projectionSpecOf, projectionWeightOf, robustnessModeOf, robustnessOf, strategyKey,
} from "@/engine/recommendation/strategy";
import { computeRecommendations } from "@/server/recommendations";
import { PATCH as stratPatch } from "@/app/api/draft/[id]/strategy/route";
import { makeRecord } from "./fixtures";

describe("projection mix / disagreement modes", () => {
  it("new drafts default to the auto mix and auto (round-aware) disagreement handling", () => {
    const s = defaultStrategy();
    expect(s).toMatchObject({ projectionMode: "auto", robustnessMode: "auto", projectionWeight: 0.6 });
    expect(s.robustness).toBeUndefined();
    expect(projectionSpecOf(s)).toBe("auto");
    expect(robustnessOf(s)).toBe(0);
  });

  it("strategies saved before the modes existed keep their meaning", () => {
    expect(parseStrategy(JSON.stringify({ preset: "balanced", riskTolerance: 0.3 }))).toMatchObject({ projectionMode: "auto", robustnessMode: "auto" });
    expect(parseStrategy(JSON.stringify({ preset: "balanced", riskTolerance: 0.3, projectionWeight: 0.6 })).projectionMode).toBe("auto"); // the old default
    const fixed = parseStrategy(JSON.stringify({ preset: "balanced", riskTolerance: 0.3, projectionWeight: 0.8 }));
    expect(fixed).toMatchObject({ projectionMode: "fixed", projectionWeight: 0.8 }); // the user picked a Mix
    expect(projectionSpecOf(fixed)).toBe(0.8);
    const robust = parseStrategy(JSON.stringify({ preset: "balanced", riskTolerance: 0.3, robustness: 0.25 }));
    expect(robust).toMatchObject({ robustnessMode: "always", robustness: 0.25 });
    // helpers on a bare object without the new fields behave the same
    expect(projectionModeOf({ ...defaultStrategy(), projectionMode: undefined, projectionWeight: 0.4 })).toBe("fixed");
    expect(robustnessModeOf({ ...defaultStrategy(), robustnessMode: undefined, robustness: 0.5 })).toBe("always");
  });

  it("patch semantics: a weight selects fixed, projectionMode auto goes back (weight kept), robustness 0 means never", () => {
    const a = applyStrategyPatch(defaultStrategy(), { projectionWeight: 0.4 });
    expect(a).toMatchObject({ projectionMode: "fixed", projectionWeight: 0.4 });
    const b = applyStrategyPatch(a, { projectionMode: "auto" });
    expect(b).toMatchObject({ projectionMode: "auto", projectionWeight: 0.4 });
    expect(applyStrategyPatch(b, { preset: "punt-ft" })).toMatchObject({ projectionMode: "auto", preset: "punt-ft" }); // presets never reset the mix
    const c = applyStrategyPatch(defaultStrategy(), { robustness: 0.3 });
    expect(c).toMatchObject({ robustnessMode: "always", robustness: 0.3 });
    expect(applyStrategyPatch(c, { robustness: 0 })).toMatchObject({ robustnessMode: "never" });
    expect(applyStrategyPatch(c, { robustness: 0 }).robustness).toBeUndefined();
    expect(applyStrategyPatch(defaultStrategy(), { robustnessMode: "always" })).toMatchObject({ robustnessMode: "always", robustness: 0.25 });
    expect(applyStrategyPatch(c, { robustnessMode: "auto" }).robustness).toBeUndefined();
  });

  it("the memo key separates the modes (auto vs fixed weight, auto vs always vs never)", () => {
    const keys = new Set([
      strategyKey(makeStrategy("balanced")),
      strategyKey(makeStrategy("balanced", undefined, undefined, { projectionWeight: 0.6, projectionMode: "fixed" })),
      strategyKey(makeStrategy("balanced", undefined, undefined, { projectionWeight: 0.8, projectionMode: "fixed" })),
      strategyKey(makeStrategy("balanced", undefined, undefined, { robustnessMode: "never" })),
      strategyKey(makeStrategy("balanced", undefined, undefined, { robustnessMode: "always" })),
    ]);
    expect(keys.size).toBe(5);
    expect(projectionWeightOf(makeStrategy("balanced", undefined, undefined, { projectionWeight: 0.8 }))).toBe(0.8);
  });

  const db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  seedFromRecords(db, Array.from({ length: 30 }, (_, i) => makeRecord({ id: `p${i}`, name: `Player ${i}`, market: { rank: i + 1, yahooAdp: i + 1 }, projection: { pts: 30 - i } })));
  const draftId = createDraft(db, { teams: 4, userSlot: 1, rounds: 5 }).id;
  const ctx = { params: Promise.resolve({ id: String(draftId) }) };
  const patch = (body: unknown) => stratPatch(new Request(`http://localhost:3000/api/draft/${draftId}/strategy`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);

  it("PATCH persists the modes and the recommendations report them", async () => {
    expect(getDraft(db, draftId)!.strategy).toMatchObject({ projectionMode: "auto", robustnessMode: "auto" });
    expect(computeRecommendations(db, draftId)!.projection).toEqual({ mode: "auto", weight: 0.6, robustness: 0, robustnessMode: "auto" });
    expect((await patch({ projectionWeight: 0.4 })).status).toBe(200);
    expect(getDraft(db, draftId)!.strategy).toMatchObject({ projectionMode: "fixed", projectionWeight: 0.4 });
    expect((await patch({ projectionMode: "auto" })).status).toBe(200);
    expect(getDraft(db, draftId)!.strategy).toMatchObject({ projectionMode: "auto", projectionWeight: 0.4 });
    expect((await patch({ robustnessMode: "never" })).status).toBe(200);
    expect(computeRecommendations(db, draftId)!.projection.robustnessMode).toBe("never");
    expect((await patch({ robustnessMode: "always" })).status).toBe(200);
    expect(computeRecommendations(db, draftId)!.projection).toMatchObject({ robustnessMode: "always", robustness: 0.25 });
    expect((await patch({ projectionMode: "nope" })).status).toBe(400);
    expect((await patch({ robustnessMode: "sometimes" })).status).toBe(400);
    updateDraftStrategy(db, draftId, { robustnessMode: "auto" });
    expect(getDraft(db, draftId)!.strategy!.robustness).toBeUndefined();
  });
});
