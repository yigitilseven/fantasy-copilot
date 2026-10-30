import { describe, it, expect } from "vitest";
import { riskLabel, riskPenalty, riskScore } from "@/engine/risk/injury";
import { makeRecord } from "./fixtures";

const base = makeRecord().risk;
const healthy = { ...base, projectedGames: 82, injuryHistoryScore: 0, restRisk: 0, availabilityScore: 1 };

describe("riskScore", () => {
  it("clean player is low", () => {
    expect(riskScore(healthy, 25)).toBe(0);
    expect(riskLabel(riskScore(healthy, 25))).toBe("Low");
  });
  it("status monotonicity", () => {
    const s = (currentStatus: typeof base.currentStatus) => riskScore({ ...healthy, currentStatus }, 25);
    expect(s("out-for-season")).toBe(100);
    expect(s("out-for-season")).toBeGreaterThanOrEqual(s("out"));
    expect(s("out")).toBeGreaterThan(s("day-to-day"));
    expect(s("day-to-day")).toBeGreaterThan(s("healthy"));
    expect(riskLabel(s("out"))).toBe("High");
  });
  it("fewer games, history, age all increase risk", () => {
    const b = riskScore(healthy, 25);
    expect(riskScore({ ...healthy, projectedGames: 55 }, 25)).toBeGreaterThan(b);
    expect(riskScore({ ...healthy, majorInjuryHistory: true }, 25)).toBeGreaterThan(b);
    expect(riskScore({ ...healthy, injuryHistoryScore: 1 }, 25)).toBeGreaterThan(b);
    expect(riskScore({ ...healthy, restRisk: 1 }, 25)).toBeGreaterThan(b);
    expect(riskScore({ ...healthy, availabilityScore: 0.5 }, 25)).toBeGreaterThan(b);
    expect(riskScore(healthy, 35)).toBeGreaterThan(riskScore(healthy, 31));
    expect(riskScore(healthy, 30)).toBe(b);
  });
  it("stays within 0..100", () => {
    const worst = { ...base, projectedGames: 0, currentStatus: "out" as const, injuryHistoryScore: 1, restRisk: 1, availabilityScore: 0, majorInjuryHistory: true };
    expect(riskScore(worst, 40)).toBe(100);
  });
  it("labels", () => {
    expect(riskLabel(34)).toBe("Low");
    expect(riskLabel(35)).toBe("Medium");
    expect(riskLabel(65)).toBe("High");
  });
});

describe("riskPenalty", () => {
  it("scales with score and tolerance, is capped", () => {
    expect(riskPenalty(0, 90, 0.3)).toBe(0);
    expect(riskPenalty(50, 90, 0.3)).toBeCloseTo(90 * 0.5 * 0.3 * 1.5);
    expect(riskPenalty(80, 90, 0.3)).toBeGreaterThan(riskPenalty(40, 90, 0.3));
    expect(riskPenalty(50, 90, 0.6)).toBeGreaterThan(riskPenalty(50, 90, 0.3));
    expect(riskPenalty(100, 90, 5)).toBeLessThanOrEqual(90 * 0.6 + 1e-9);
  });
});
