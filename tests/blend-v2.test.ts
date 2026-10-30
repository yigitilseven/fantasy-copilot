import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLEND_WEIGHTS, MINUTES_ELASTICITY, applyProjectionBlend, availabilityGames, blendAuto, blendLines, blendRecordAuto, canonicalTeam,
  impliedMinutes, per36Of, playerBlendWeights, realRates, TARGET_SAMPLE_MINUTES,
} from "@/engine/projection/blend";
import type { BlendEvidence, PlayerRecord, ProjectionLine } from "@/types";
import { makeRecord } from "./fixtures";

const line = (o: Partial<ProjectionLine> = {}): ProjectionLine => ({
  games: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, ...o,
});
const W = DEFAULT_BLEND_WEIGHTS;
const sample = (o: Partial<ProjectionLine> = {}, team: string | null = "AAA") => ({ line: line(o), team });
const proj = (minutes = 30) => ({ line: line(), minutes });

describe("playerBlendWeights: rules", () => {
  const vet = { age: 27, team: "AAA", fromYear: 2018 };

  it("stable veteran (two 60+ GP seasons, same team, age 24-31) leans on real stats", () => {
    const w = playerBlendWeights(vet, sample(), sample(), proj());
    expect(w).toMatchObject({ wRate: W.vet, wVol: W.vol });
    expect(w.reasons[0]).toMatch(/stable veteran/);
  });

  it("default when no rule applies (e.g. only one 60+ GP season)", () => {
    expect(playerBlendWeights(vet, sample(), sample({ games: 50 }), proj())).toMatchObject({ wRate: W.base, reasons: ["default"] });
  });

  it("rookie (no real data), age <= 23 and <= 2nd season lean on the projection", () => {
    expect(playerBlendWeights({ age: 20, team: "AAA" }, null, null, proj())).toMatchObject({ wRate: W.young });
    expect(playerBlendWeights({ age: 23, team: "AAA", fromYear: 2022 }, sample(), sample(), proj()).reasons[0]).toMatch(/young \(age 23\)/);
    expect(playerBlendWeights({ ...vet, fromYear: 2025 }, sample(), null, proj())).toMatchObject({ wRate: W.young });
    expect(playerBlendWeights({ ...vet, fromYear: 2025 }, sample(), null, proj()).reasons[0]).toBe("2nd-year player");
    // without the index, a missing 2024-25 line stands in for "2nd season"
    expect(playerBlendWeights({ age: 27, team: "AAA" }, sample(), null, proj()).wRate).toBe(W.young);
    expect(playerBlendWeights({ age: 24, team: "AAA", fromYear: 2022 }, sample(), sample(), proj()).wRate).not.toBe(W.young);
  });

  it("team change (2025-26 vs 2026-27 team, aliases normalised) and implied role change", () => {
    const tc = playerBlendWeights({ ...vet, team: "BBB" }, sample(), sample(), proj());
    expect(tc.wRate).toBe(W.change);
    expect(tc.reasons[0]).toBe("team change AAA to BBB");
    expect(playerBlendWeights({ ...vet, team: "NY" }, sample({}, "NYK"), sample({}, "NYK"), proj()).wRate).toBe(W.vet);
    expect(canonicalTeam("UTH")).toBe("UTA");
    expect(canonicalTeam("FA")).toBeNull();
    const rc = playerBlendWeights(vet, sample({ minutes: 24 }), sample(), proj(30));
    expect(rc.wRate).toBe(W.change);
    expect(rc.reasons[0]).toMatch(/role change \(\+6\.0 MPG/);
    expect(playerBlendWeights(vet, sample({ minutes: 26 }), sample({ minutes: 26 }), proj(30)).wRate).toBe(W.vet); // 4 MPG: below the 5 MPG threshold
  });

  it("injury return (GP < 40) leans on the projection for rates and more so for volume", () => {
    const w = playerBlendWeights(vet, sample({ games: 38 }), sample(), proj());
    expect(w).toMatchObject({ wRate: W.injury, wVol: W.injuryVol });
    expect(w.reasons[0]).toMatch(/injury return \(38 GP/);
    expect(playerBlendWeights(vet, sample({ games: 40 }), sample(), proj()).wVol).toBe(W.vol);
    // missed all of 2025-26 but played 2024-25
    expect(playerBlendWeights(vet, null, sample(), proj()).wVol).toBe(W.injuryVol);
  });

  it("age 32+ leans on the projection", () => {
    expect(playerBlendWeights({ age: 33, team: "AAA", fromYear: 2010 }, sample(), sample(), proj())).toMatchObject({ wRate: W.age32 });
    expect(playerBlendWeights({ age: 31, team: "AAA", fromYear: 2010 }, sample(), sample(), proj()).wRate).toBe(W.vet);
  });

  it("combines the lean-projection rules as the max, in strength order; the veteran rule only applies when none does", () => {
    const w = playerBlendWeights({ age: 33, team: "BBB", fromYear: 2010 }, sample({ games: 30 }), sample(), proj());
    expect(w.wRate).toBe(Math.max(W.change, W.injury, W.age32));
    expect(w.reasons).toHaveLength(3);
    expect(w.reasons[0]).toMatch(/injury return/);
    const young = playerBlendWeights({ age: 21, team: "BBB" }, sample(), sample(), proj());
    expect(young.wRate).toBe(Math.max(W.young, W.change));
  });

  it("the calibrated defaults stay within [0.3, 0.9] and keep the agreed ordering", () => {
    for (const v of Object.values(W)) {
      expect(v).toBeGreaterThanOrEqual(0.3);
      expect(v).toBeLessThanOrEqual(0.9);
    }
    expect(W.vet).toBeLessThan(W.base);
    expect(W.base).toBeLessThan(W.age32);
    expect(W.age32).toBeLessThan(W.change);
    expect(W.change).toBeLessThanOrEqual(W.young);
    expect(W.vol).toBeGreaterThanOrEqual(0.8);
  });
});

describe("rates, minutes and the rate/volume blend", () => {
  it("per36Of scales every field by 36/minutes", () => {
    const r = per36Of(line({ minutes: 24, pts: 12 }));
    expect(r.pts).toBeCloseTo(18);
    expect(r.fga).toBeCloseTo(15 * 1.5);
  });

  it("impliedMinutes scales the anchor by the production ratio^elasticity and clamps", () => {
    const anchor = { mpg: 30, line: line() };
    expect(impliedMinutes(line(), anchor)).toBeCloseTo(30);
    const up = line({ pts: 24, reb: 6, ast: 4.8, stl: 1.2, blk: 0.6, tov: 2 }); // ~ +20% production
    const m = impliedMinutes(up, anchor);
    expect(m).toBeGreaterThan(30);
    expect(m).toBeCloseTo(30 * (productionRatio(up) ** MINUTES_ELASTICITY), 6);
    expect(impliedMinutes(line({ pts: 400, reb: 100, ast: 100 }), anchor)).toBe(40);
    expect(impliedMinutes(line({ pts: 1, reb: 0, ast: 0, stl: 0, blk: 0 }), anchor)).toBe(8);
  });
  function productionRatio(l: ProjectionLine) {
    const p = (x: ProjectionLine) => x.pts + 1.2 * x.reb + 1.5 * x.ast + 3 * x.stl + 3 * x.blk - x.tov;
    return p(l) / p(line());
  }

  it("realRates: 2025-26 alone for a full sample, topped up with 2024-25 when the sample is small", () => {
    const full = line({ games: 70, minutes: 30, pts: 20 }); // 2100 min >= target
    expect(realRates(full, line({ pts: 10 }))!.pts).toBeCloseTo(20 * 36 / 30);
    const small = line({ games: 20, minutes: 30, pts: 10 }); // 600 min: 900 missing, 24 gives min(0.5 * 2100, 900) = 900
    const r = realRates(small, line({ games: 70, minutes: 30, pts: 20 }))!;
    const expected = (10 * 600 + 20 * 900) / 1500 * (36 / 30);
    expect(r.pts).toBeCloseTo(expected);
    expect(600 + 900).toBe(TARGET_SAMPLE_MINUTES);
    expect(realRates(null, line({ pts: 20 }))!.pts).toBeCloseTo(24);
    expect(realRates(null, null)).toBeNull();
  });

  const ev: BlendEvidence = { age: 27, team26: "AAA", team25: "AAA", team24: "AAA", fromYear: 2015 };
  const yahoo = line({ games: 72, minutes: 0, pts: 19.5, fgm: 6.9, fga: 14.8, ftm: 3.7, fta: 5.2, threePm: 1.8, reb: 5.2, ast: 4.2, stl: 1.05, blk: 0.45, tov: 2.1 });
  const actual = line({ games: 66, minutes: 32, pts: 18, fgm: 6.4, fga: 14, ftm: 3.2, fta: 5, threePm: 1.6, reb: 5, ast: 4, stl: 1, blk: 0.4, tov: 2 });
  const prev = line({ games: 68, minutes: 31, pts: 17, fgm: 6, fga: 13.5, ftm: 3, fta: 4.8, threePm: 1.5, reb: 5, ast: 3.8, stl: 1, blk: 0.4, tov: 2 });

  it("final line = blended per-36 rates x blended minutes / 36; games and minutes use the volume weight", () => {
    const b = blendAuto({ proj: yahoo, actual, actualPrev: prev, evidence: ev })!;
    const { wRate, wVol, yahooMinutes } = b.info as { wRate: number; wVol: number; yahooMinutes: number };
    expect(b.info.mode).toBe("auto");
    expect([wRate, wVol]).toEqual([W.vet, W.vol]);
    const minutes = wVol * yahooMinutes + (1 - wVol) * actual.minutes;
    expect(b.line.minutes).toBeCloseTo(minutes);
    expect(b.line.games).toBeCloseTo(wVol * 72 + (1 - wVol) * availabilityGames(66));
    const yr = per36Of(yahoo, yahooMinutes);
    const rr = realRates(actual, prev)!;
    expect(b.line.pts).toBeCloseTo((wRate * yr.pts + (1 - wRate) * rr.pts) * minutes / 36);
    expect(b.line.reb).toBeCloseTo((wRate * yr.reb + (1 - wRate) * rr.reb) * minutes / 36);
  });

  it("a real line without minutes (stats cache missing) falls back to the projection instead of crashing", () => {
    const noMin = { ...actual, minutes: 0 };
    const b = blendAuto({ proj: yahoo, actual: noMin, actualPrev: null, evidence: ev })!;
    expect(b.info.effectiveWeight).toBe(1);
    expect(b.line).toBe(yahoo);
    // 2024-25 still usable: blends against it
    const c = blendAuto({ proj: yahoo, actual: noMin, actualPrev: prev, evidence: ev })!;
    expect(Number.isFinite(c.line.pts)).toBe(true);
    expect(c.line.minutes).toBeGreaterThan(0);
  });

  it("shooting stays consistent: makes and attempts are blended separately, so FG% / FT% are Σmakes/Σattempts", () => {
    const b = blendAuto({ proj: yahoo, actual, actualPrev: prev, evidence: ev })!;
    const wRate = b.info.wRate!;
    const yr = per36Of(yahoo, b.info.yahooMinutes!);
    const rr = realRates(actual, prev)!;
    const fgm36 = wRate * yr.fgm + (1 - wRate) * rr.fgm;
    const fga36 = wRate * yr.fga + (1 - wRate) * rr.fga;
    expect(b.line.fgm / b.line.fga).toBeCloseTo(fgm36 / fga36, 10);
    expect(b.line.ftm / b.line.fta).toBeCloseTo((wRate * yr.ftm + (1 - wRate) * rr.ftm) / (wRate * yr.fta + (1 - wRate) * rr.fta), 10);
    // not the naive mix of the two percentages when the sources shoot at very different volumes
    const y2 = line({ games: 72, minutes: 0, pts: 20, fgm: 6, fga: 10, ftm: 4, fta: 4.4, threePm: 1.6, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2 });
    const a2 = line({ games: 66, minutes: 32, pts: 18, fgm: 4.8, fga: 12, ftm: 3, fta: 6, threePm: 1.6, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2 });
    const c = blendAuto({ proj: y2, actual: a2, actualPrev: null, evidence: ev })!;
    const naive = c.info.wRate! * (6 / 10) + (1 - c.info.wRate!) * (4.8 / 12);
    expect(c.line.fgm / c.line.fga).toBeGreaterThan(0.4);
    expect(c.line.fgm / c.line.fga).toBeLessThan(0.6);
    expect(Math.abs(c.line.fgm / c.line.fga - naive)).toBeGreaterThan(1e-3);
  });

  it("the scoring identity PTS = 2*FGM + 3PM + FTM survives the blend when both sources satisfy it", () => {
    const y = line({ games: 72, pts: 2 * 9 + 2.4 + 6, fgm: 9, fga: 18, ftm: 6, fta: 7, threePm: 2.4 });
    const a = line({ pts: 2 * 6.4 + 1.6 + 3.2, fgm: 6.4, fga: 14, ftm: 3.2, fta: 5, threePm: 1.6 });
    const p = line({ pts: 2 * 6.4 + 1.6 + 3.2, fgm: 6.4, fga: 14, ftm: 3.2, fta: 5, threePm: 1.6 });
    const b = blendAuto({ proj: y, actual: a, actualPrev: p, evidence: ev })!.line;
    expect(b.pts).toBeCloseTo(2 * b.fgm + b.threePm + b.ftm, 8);
  });

  it("w_rate = w_vol = 1 gives the projection exactly; w_rate = w_vol = 0 gives the real rates at real minutes", () => {
    const one = { young: 1, change: 1, injury: 1, injuryVol: 1, age32: 1, vet: 1, base: 1, vol: 1 };
    const b1 = blendAuto({ proj: yahoo, actual, actualPrev: null, evidence: ev }, one)!;
    expect(b1.line.pts).toBeCloseTo(yahoo.pts);
    expect(b1.line.fga).toBeCloseTo(yahoo.fga);
    expect(b1.line.games).toBeCloseTo(yahoo.games);
    const zero = { young: 0, change: 0, injury: 0, injuryVol: 0, age32: 0, vet: 0, base: 0, vol: 0 };
    const b0 = blendAuto({ proj: yahoo, actual, actualPrev: null, evidence: ev }, zero)!;
    expect(b0.line.pts).toBeCloseTo(actual.pts);
    expect(b0.line.minutes).toBeCloseTo(actual.minutes);
    expect(b0.line.games).toBeCloseTo(availabilityGames(66));
  });

  it("FantasyPros minutes anchor the projected minutes when listed", () => {
    const fp = line({ games: 70, minutes: 35, pts: 23 });
    const withFp = blendAuto({ proj: yahoo, fantasyPros: fp, actual, actualPrev: prev, evidence: ev })!;
    const noFp = blendAuto({ proj: yahoo, actual, actualPrev: prev, evidence: ev })!;
    expect(withFp.info.yahooMinutes).toBeCloseTo(impliedMinutes(yahoo, { mpg: 35, line: fp }));
    expect(withFp.info.yahooMinutes).not.toBeCloseTo(noFp.info.yahooMinutes!, 1);
  });

  it("reliability fallbacks: no projection -> actual (or nothing for a tiny sample), no real data / few games -> projection only", () => {
    expect(blendAuto({ proj: null, actual, evidence: ev })!.info).toMatchObject({ effectiveWeight: 0, reason: "no-yahoo" });
    expect(blendAuto({ proj: null, actual: line({ games: 6 }), evidence: ev })).toBeNull();
    expect(blendAuto({ proj: null, actual: null, evidence: ev })).toBeNull();
    const rook = blendAuto({ proj: yahoo, actual: null, evidence: ev })!;
    expect(rook.line).toBe(yahoo);
    expect(rook.info).toMatchObject({ effectiveWeight: 1, reason: "no-actual" });
    expect(blendAuto({ proj: yahoo, actual: line({ games: 12 }), evidence: ev })!.info).toMatchObject({ reason: "low-gp", effectiveWeight: 1 });
    // a short 2025-26 season is rescued by a full 2024-25 season (injury-return weights)
    const rescued = blendAuto({ proj: yahoo, actual: line({ games: 12 }), actualPrev: prev, evidence: ev })!;
    expect(rescued.info.wVol).toBe(W.injuryVol);
    expect(rescued.info.reasons![0]).toMatch(/injury return/);
  });

  it("blendRecordAuto / applyProjectionBlend('auto') annotate the record and leave record without components alone", () => {
    const base = makeRecord({ id: "a", age: 26 });
    const r: PlayerRecord = { ...base, projection: { ...base.projection, ...yahoo, projectionSource: "yahoo-2026-27", components: { yahoo, actual, actualPrev: prev, projection: yahoo, evidence: ev } } };
    const out = blendRecordAuto(r);
    expect(out.projection.projectionSource).toBe("blend");
    expect(out.projection.blend).toMatchObject({ mode: "auto", wRate: W.vet, wVol: W.vol });
    expect(applyProjectionBlend([r], "auto")[0].projection.blend?.mode).toBe("auto");
    const plain = makeRecord({ id: "p" });
    expect(applyProjectionBlend([plain], "auto")[0]).toBe(plain);
    // fixed weights still work (v1) and use the projection side
    const cons = line({ pts: 30 });
    const r2: PlayerRecord = { ...r, projection: { ...r.projection, components: { ...r.projection.components!, projection: cons } } };
    expect(applyProjectionBlend([r2], 0.5)[0].projection.pts).toBeCloseTo(0.5 * 30 + 0.5 * actual.pts);
    expect(blendLines(cons, actual, 0.5)!.line.pts).toBeCloseTo(0.5 * 30 + 0.5 * actual.pts);
  });

  it("falls back to age + 1 and no team facts when a record carries no evidence", () => {
    const base = makeRecord({ id: "a", age: 22 });
    const r: PlayerRecord = { ...base, projection: { ...base.projection, ...yahoo, components: { yahoo, actual, projection: yahoo } } };
    expect(blendRecordAuto(r).projection.blend!.reasons![0]).toMatch(/young \(age 23\)/);
  });
});
