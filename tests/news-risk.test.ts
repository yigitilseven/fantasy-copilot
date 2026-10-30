import { describe, expect, it } from "vitest";
import type { PlayerRecord, Risk } from "@/types";
import { computeValuations } from "@/engine/valuation/value";
import { injuryText, scorePlayers, type RecommendInput } from "@/engine/recommendation";
import { applyStatusUpdate } from "@/engine/risk/status";
import { gamesMissedUntil } from "@/engine/risk/calendar";
import { availableShare, hasNearReturn, riskScore } from "@/engine/risk/injury";
import { makeRecord } from "./fixtures";

const NOW = Date.parse("2026-10-07T14:00:00Z");
const healthy: Risk = { ...makeRecord().risk, projectedGames: 82, injuryHistoryScore: 0, restRisk: 0, availabilityScore: 1 };

describe("riskScore with ingested status", () => {
  it("day-to-day is a small penalty, cleared is back to normal", () => {
    const base = riskScore(healthy, 25, 82, NOW);
    const dtd = riskScore({ ...healthy, currentStatus: "day-to-day" }, 25, 82, NOW);
    expect(dtd - base).toBeGreaterThan(0);
    expect(dtd - base).toBeLessThanOrEqual(6);
    const cleared = riskScore({ ...healthy, currentStatus: "healthy", statusSource: "cleared", statusUpdatedAt: "2026-10-07T00:00:00Z" }, 25, 82, NOW);
    expect(cleared).toBe(base);
  });
  it("recency bump: fresh non-healthy report adds a small amount, decaying to 0 after 7 days", () => {
    const mk = (days: number) => riskScore({ ...healthy, currentStatus: "day-to-day", statusUpdatedAt: new Date(NOW - days * 86_400_000).toISOString() }, 25, 82, NOW);
    expect(mk(0)).toBeGreaterThan(mk(3));
    expect(mk(3)).toBeGreaterThan(mk(7));
    expect(mk(7)).toBe(mk(30));
    expect(mk(0) - mk(30)).toBeLessThanOrEqual(5);
  });
  it("out with a near return has no flat 70 floor; far/unknown return keeps it; out-for-season is 100", () => {
    const near = applyStatusUpdate({ ...healthy, projectedGames: 70 }, { status: "out", injury: "Knee", estReturnDate: "2026-12-10", source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" }, [], NOW);
    expect(hasNearReturn(near, NOW)).toBe(true);
    expect(riskScore(near, 27, 82, NOW)).toBeLessThan(70);
    expect(riskScore(near, 27, 82, NOW)).toBeGreaterThan(riskScore({ ...healthy, projectedGames: 70 }, 27, 82, NOW));
    expect(riskScore({ ...healthy, currentStatus: "out" }, 27, 82, NOW)).toBeGreaterThanOrEqual(70); // no return date
    const far = applyStatusUpdate(healthy, { status: "out", injury: null, estReturnDate: "2027-04-01", source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" }, [], NOW);
    expect(riskScore(far, 27, 82, NOW)).toBeGreaterThanOrEqual(70);
    expect(riskScore({ ...healthy, currentStatus: "out-for-season" }, 25, 82, NOW)).toBe(100);
  });
  it("out with a known return: risk stays near the healthy baseline (missed games are priced into value instead)", () => {
    const short = applyStatusUpdate(healthy, { status: "out", injury: null, estReturnDate: "2026-10-26", source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" }, [], NOW);
    const s = riskScore(short, 25, 82, NOW);
    const h = riskScore(healthy, 25, 82, NOW);
    expect(s).toBeLessThan(70);
    expect(s).toBeGreaterThan(h);
    expect(s - h).toBeLessThanOrEqual(15);
  });
  it("availableShare", () => {
    expect(availableShare(0)).toBe(1);
    expect(availableShare(30)).toBeCloseTo(1 - (0.75 * 30) / 82, 5);
    expect(availableShare(30)).toBeGreaterThan(0.7);
  });
});

describe("applyStatusUpdate math", () => {
  it("projected games reduced by games missed; OFS -> 0; cleared untouched", () => {
    const r = { ...healthy, projectedGames: 70 };
    const out = applyStatusUpdate(r, { status: "out", injury: "Knee", estReturnDate: "2026-12-20", source: "CBS", reportedAt: "2026-10-05T00:00:00Z" }, [], NOW);
    expect(out.gamesMissed).toBe(gamesMissedUntil("2026-12-20", NOW));
    expect(out.projectedGames).toBe(70 - out.gamesMissed!);
    expect(out).toMatchObject({ currentStatus: "out", injuryNote: "Knee", estReturn: "2026-12-20", statusSource: "CBS" });
    expect(applyStatusUpdate(r, { status: "out-for-season", injury: null, estReturnDate: null, source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" }, [], NOW).projectedGames).toBe(0);
    const cl = applyStatusUpdate(r, { status: "healthy", injury: null, estReturnDate: null, source: "cleared", reportedAt: "2026-10-06T00:00:00Z" }, [], NOW);
    expect(cl).toMatchObject({ currentStatus: "healthy", projectedGames: 70, statusSource: "cleared" });
    expect(cl.estReturn).toBeUndefined();
    expect(Math.max(0, 70 - 99)).toBe(0);
  });
  it("explain text", () => {
    expect(injuryText({ currentStatus: "out", estReturn: "2026-11-15", statusSource: "ESPN", statusUpdatedAt: "2026-10-06T10:00:00Z" })).toBe("Out — est. return Nov 15 (ESPN, Oct 6)");
    expect(injuryText({ currentStatus: "healthy" })).toBeNull();
    expect(injuryText({ currentStatus: "out-for-season", statusSource: "CBS", statusUpdatedAt: "2026-09-21T00:00:00Z" })).toBe("Out for the season (CBS, Sep 21)");
  });
});

// ---------------------------------------------------------------- recommender: AVOID vs IL stash

function universe(n = 220): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  for (let i = 0; i < n; i++) {
    const q = 1 - i / n;
    const k = i % 5;
    out.push(
      makeRecord({
        id: `u${i}`, positions: [(["PG", "SG", "SF", "PF", "C"] as const)[k]],
        projection: { pts: 8 + 18 * q + (k % 2), threePm: 0.5 + 2 * q * (k < 2 ? 1.3 : 0.4), reb: 3 + 8 * q * (k > 2 ? 1.4 : 0.5), ast: 1.5 + 6 * q * (k < 2 ? 1.4 : 0.4), stl: 0.5 + q, blk: 0.2 + 1.2 * q * (k > 2 ? 1.5 : 0.3), tov: 1 + 2 * q },
        market: { yahooAdp: i + 1, rank: i + 1 },
      }),
    );
  }
  return out;
}

function withStatus(records: PlayerRecord[], id: string, u: Parameters<typeof applyStatusUpdate>[1]): PlayerRecord[] {
  return records.map((r) => (r.player.id === id ? { ...r, risk: applyStatusUpdate(r.risk, u, [], NOW) } : r));
}
const out2mo = { status: "out" as const, injury: "Knee", estReturnDate: "2026-12-10", source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" };

function input(records: PlayerRecord[], round: number, rosterIds: string[], over: Partial<RecommendInput> = {}): RecommendInput {
  const { valuations } = computeValuations(records);
  return {
    records, valuations, draftedIds: rosterIds, userRosterIds: rosterIds, currentPick: (round - 1) * 14 + 5, userNextPick: round * 14 + 10,
    isUserOnClock: false, survival: null, config: { teams: 14 }, rounds: 13, now: NOW, ...over,
  };
}
const find = (s: ReturnType<typeof scorePlayers>, id: string) => s.find((x) => x.playerId === id)!;
const roster11 = Array.from({ length: 11 }, (_, i) => `u${100 + i}`);

describe("IL stash", () => {
  const base = universe();
  const star = "u3";

  it("round 2: a star out two months is not blanket-AVOID; he keeps ~his season share of value (no stash yet)", () => {
    const recs = withStatus(base, star, out2mo);
    const st = find(scorePlayers(input(recs, 2, ["u50", "u51"])), star);
    const healthyStar = find(scorePlayers(input(base, 2, ["u50", "u51"])), star);
    expect(st.ilStash).toBeUndefined();
    expect(st.recommendation).not.toBe("AVOID");
    expect(st.riskScore).toBeLessThan(70);
    const ratio = st.riskAdjusted / healthyStar.riskAdjusted;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.8);
  });

  it("round 12 with a free IL slot: stash-eligible, not AVOID, ranked above replacement-level players, reason explains", () => {
    const recs = withStatus(base, star, out2mo);
    const s = scorePlayers(input(recs, 12, roster11));
    const st = find(s, star);
    expect(st.ilStash).toBe(true);
    expect(st.recommendation).not.toBe("AVOID");
    expect(["TAKE", "RISKY WAIT", "WAIT", "DRAFT"]).toContain(st.recommendation);
    expect(st.riskScore).toBeLessThan(70);
    const healthyReplacement = s.filter((x) => Number(x.playerId.slice(1)) >= 150 && x.playerId !== star);
    expect(healthyReplacement.length).toBeGreaterThan(10);
    for (const r of healthyReplacement) expect(st.riskAdjusted).toBeGreaterThan(r.riskAdjusted);
    expect(st.reason).toMatch(/IL stash: out until ~Dec 10 \(ESPN\), ~\d+% of season left — strong value for a late pick\./);
    // value is scaled by the season share, not the full penalty: roughly 70-75% of the healthy score
    const healthyStar = find(scorePlayers(input(base, 12, roster11)), star);
    const ratio = st.riskAdjusted / healthyStar.riskAdjusted;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.8);
  });

  it("no free IL slot -> no stash bonus (full season-share cost, lower than with a free slot)", () => {
    let recs = withStatus(base, star, out2mo);
    recs = withStatus(recs, "u100", { ...out2mo, estReturnDate: "2027-01-10" });
    recs = withStatus(recs, "u101", { ...out2mo, estReturnDate: "2027-01-10" });
    const s = scorePlayers(input(recs, 12, roster11, { ilSlots: 2 }));
    expect(find(s, star).ilStash).toBeUndefined();
    // with 3 IL slots there is room again, and the stash is worth more
    const withSlot = find(scorePlayers(input(recs, 12, roster11, { ilSlots: 3 })), star);
    expect(withSlot.ilStash).toBe(true);
    expect(withSlot.riskAdjusted).toBeGreaterThan(find(s, star).riskAdjusted);
  });

  it("out-for-season is always AVOID, even in the last round with a free IL slot", () => {
    const recs = withStatus(base, star, { status: "out-for-season", injury: "ACL", estReturnDate: "2027-07-01", source: "ESPN", reportedAt: "2026-10-05T00:00:00Z" });
    const s = scorePlayers(input(recs, 13, roster11));
    expect(find(s, star).recommendation).toBe("AVOID");
    expect(find(s, star).riskScore).toBe(100);
  });

  it("out with no return date is not a stash candidate", () => {
    const recs = base.map((r) => (r.player.id === star ? { ...r, risk: { ...r.risk, currentStatus: "out" as const } } : r));
    expect(find(scorePlayers(input(recs, 12, roster11)), star).recommendation).toBe("AVOID");
  });

  it("day-to-day is a small penalty and never AVOID in round 1", () => {
    const recs = base.map((r) => (r.player.id === star ? { ...r, risk: { ...r.risk, currentStatus: "day-to-day" as const, statusSource: "CBS", statusUpdatedAt: "2026-10-07T00:00:00Z" } } : r));
    const a = find(scorePlayers(input(recs, 1, [])), star);
    const b = find(scorePlayers(input(base, 1, [])), star);
    expect(a.recommendation).not.toBe("AVOID");
    expect(b.riskAdjusted - a.riskAdjusted).toBeGreaterThan(0);
    expect(b.riskAdjusted - a.riskAdjusted).toBeLessThan(0.1 * b.riskAdjusted);
    expect(a.reason).toContain("Day-to-day (CBS, Oct 7)");
  });
});
