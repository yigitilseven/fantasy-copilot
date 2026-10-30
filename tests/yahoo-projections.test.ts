import { beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.fn();
vi.mock("@/server/recommendations", async (orig) => {
  const m = await orig<typeof import("@/server/recommendations")>();
  return { ...m, invalidateRecommendationCaches: () => { invalidate(); m.invalidateRecommendationCaches(); } };
});

import { createDb } from "@/db/client";
import { createDraft, getAllPlayerRecords } from "@/db/repository";
import { players } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { ingestDomPicks } from "@/integrations/yahoo/dom-ingest";
import { deriveAttempts, mergeYahooMarket, mergeYahooProjection } from "@/integrations/yahoo/projection-merge";
import { POST as projPost, GET as projGet, OPTIONS as projOptions } from "@/app/api/projections/yahoo/route";
import { GET as statusGet } from "@/app/api/projections/yahoo/status/route";
import { GET as playersGet } from "@/app/api/players/route";
import { computeRecommendations, resetRecommendationCaches } from "@/server/recommendations";
import { yahooAlert, QUIET_MESSAGE, type BrowserStatus } from "@/store/browser-sync";
import { computeValuations } from "@/engine/valuation/value";
import { makeRecord } from "./fixtures";
import { eq } from "drizzle-orm";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
type Db = ReturnType<typeof createDb>;
let db: Db;

const row = (o: Record<string, unknown>) => ({
  yahooId: "1", playerName: "J. Murray", nbaTeam: "DEN", positions: "PG", adp: 20, gp: 70, fgPct: 0.5, ftPct: 0.8, threePm: 140, pts: 1750, reb: 350, ast: 420, stl: 70, blk: 21, tov: 140, ...o,
});
const post = (rows: unknown[], origin?: string) =>
  projPost(new Request("http://localhost:3000/api/projections/yahoo", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ season: "2026-27", view: "proj", rows }) }));

beforeEach(() => {
  invalidate.mockClear();
  resetRecommendationCaches();
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  seedFromRecords(db, [
    makeRecord({ id: "jamal-murray", name: "Jamal Murray", positions: ["PG"], projection: { pts: 20, fga: 15, fta: 3, fgm: 6.5, ftm: 2.5, games: 60, minutes: 32 }, market: { yahooAdp: 30, rank: 30 } }),
    makeRecord({ id: "keegan-murray", name: "Keegan Murray", positions: ["SF", "PF"], market: { yahooAdp: 40, rank: 40 } }),
    makeRecord({ id: "ph", name: "Placeholder Guy", market: { yahooAdp: 999, rank: 999 } }),
  ]);
  for (const id of ["jamal-murray", "keegan-murray"]) db.update(players).set({ nbaTeam: id === "jamal-murray" ? "DEN" : "SAC" }).where(eq(players.id, id)).run();
});

describe("attempts derivation", () => {
  it("recovers FGA/FTA from PTS, 3PM and the percentages via the points identity", () => {
    // 18 FGA at 50% (9 FGM), 6 FTA at 80% (4.8 FTM), 2 3PM: PTS = 18 + 2 + 4.8 = 24.8
    const a = deriveAttempts({ ptsPg: 24.8, threePmPg: 2, fgPct: 0.5, ftPct: 0.8, base: { pts: 20, fga: 15, fta: 5 } });
    expect(a.method).toBe("identity");
    expect(a.fga).toBeCloseTo(18, 5);
    expect(a.fta).toBeCloseTo(6, 5);
    expect(a.fgm).toBeCloseTo(9, 5);
    expect(a.ftm).toBeCloseTo(4.8, 5);
  });
  it("uses the league FTA/FGA ratio without a base line and falls back to attempts-per-point on junk percentages", () => {
    const a = deriveAttempts({ ptsPg: 20, threePmPg: 2, fgPct: 0.5, ftPct: 0.8, base: null });
    expect(a.fta / a.fga).toBeCloseTo(0.3, 6);
    const bad = deriveAttempts({ ptsPg: 20, threePmPg: 2, fgPct: 0.05, ftPct: 0.8, base: { pts: 20, fga: 16, fta: 4 } });
    expect(bad.method).toBe("per-point");
    expect(bad.fga).toBeCloseTo(16, 6);
  });
  it("mergeYahooProjection: totals / GP, games = GP, source tag; unusable rows -> null", () => {
    const base = makeRecord({ id: "x" }).projection;
    const p = mergeYahooProjection(base, { gp: 50, fgPct: 0.5, ftPct: 0.8, threePm: 100, pts: 1000, reb: 400, ast: 250, stl: 50, blk: 25, tov: 100 })!;
    expect(p).toMatchObject({ games: 50, pts: 20, threePm: 2, reb: 8, ast: 5, stl: 1, blk: 0.5, tov: 2, projectionSource: "yahoo-2026-27", minutes: base.minutes });
    expect(p.fgm / p.fga).toBeCloseTo(0.5, 9);
    expect(p.ftm / p.fta).toBeCloseTo(0.8, 9);
    expect(2 * p.fgm + p.threePm + p.ftm).toBeCloseTo(20, 6);
    expect(mergeYahooProjection(base, { gp: 0, fgPct: 0.5, ftPct: 0.8, threePm: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 1 })).toBeNull();
    expect(mergeYahooProjection(base, { gp: 50, fgPct: null, ftPct: 0.8, threePm: 1, pts: 1, reb: 1, ast: 1, stl: 1, blk: 1, tov: 1 })).toBeNull();
  });
  it("Yahoo's draft-room ADP always replaces the imported market ADP; no Yahoo ADP keeps ours", () => {
    expect(mergeYahooMarket("a", { playerId: "a", yahooAdp: 41, adpStdDev: 5.7, rank: 41 }, 111.9)).toMatchObject({ yahooAdp: 111.9, rank: 112 });
    expect(mergeYahooMarket("a", { playerId: "a", yahooAdp: 999, adpStdDev: 22, rank: 999 }, 12)).toMatchObject({ yahooAdp: 12, rank: 12 });
    expect(mergeYahooMarket("yahoo-x-den", { playerId: "yahoo-x-den", yahooAdp: 320, adpStdDev: 22, rank: 320 }, null).yahooAdp).toBe(320);
  });
});

describe("POST /api/projections/yahoo", () => {
  it("matches by name+team, creates unknown players, sets yahoo keys, reports status, invalidates caches", async () => {
    const res = await post([row({ yahooId: "5001" }), row({ yahooId: "9001", playerName: "D. Rookie", nbaTeam: "UTA", positions: "PG,SG", adp: null, rank: 120 }), row({ yahooId: "7", playerName: "Placeholder Guy", nbaTeam: "TST", adp: 88 })], YAHOO);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(YAHOO);
    const j = await res.json();
    expect(j).toMatchObject({ received: 3, matched: 3, created: 1, keysSet: 2 });
    expect(invalidate).toHaveBeenCalledTimes(1);

    const recs = getAllPlayerRecords(db);
    const jamal = recs.find((r) => r.player.id === "jamal-murray")!;
    expect(jamal.player.yahooPlayerKey).toBe("nba.p.5001");
    expect(jamal.projection).toMatchObject({ projectionSource: "yahoo-2026-27", games: 70, pts: 25 });
    expect(recs.find((r) => r.player.id === "keegan-murray")!.projection.projectionSource).toBe("nba-stats");
    const rookie = recs.find((r) => r.player.id === "yahoo-d-rookie-uta")!;
    expect(rookie).toBeTruthy();
    expect(rookie.player).toMatchObject({ name: "D. Rookie", nbaTeam: "UTA", positions: ["PG", "SG"], yahooPlayerKey: "nba.p.9001" });
    expect(rookie.market.yahooAdp).toBe(420); // no Yahoo ADP: 300 + Yahoo rank
    expect(rookie.projection.projectionSource).toBe("yahoo-2026-27");
    expect(recs.find((r) => r.player.id === "ph")!.market.yahooAdp).toBe(88); // placeholder ADP replaced

    const st = await (await statusGet(new Request("http://localhost/api/projections/yahoo/status"))).json();
    expect(st).toMatchObject({ count: 3, matched: 3, created: 1, usable: 3, season: "2026-27" });
    expect(st.capturedAt).toBeTruthy();
    expect((await (await projGet(new Request("http://localhost/x"))).json()).count).toBe(3);
  });

  it("second capture is an upsert, matched by Yahoo id (no duplicates, no new players)", async () => {
    await post([row({ yahooId: "5001" }), row({ yahooId: "9001", playerName: "D. Rookie", nbaTeam: "UTA", positions: "PG" })]);
    const n = db.select().from(players).all().length;
    const j = await (await post([row({ yahooId: "5001", pts: 2100 }), row({ yahooId: "9001", playerName: "D. Rookie", nbaTeam: "UTA", positions: "PG" })])).json();
    expect(j).toMatchObject({ matched: 2, created: 0, keysSet: 0 });
    expect(db.select().from(players).all().length).toBe(n);
    expect(getAllPlayerRecords(db).find((r) => r.player.id === "jamal-murray")!.projection.pts).toBe(30);
  });

  it("does not mistake a rookie for a same-initial namesake on another team/position; ambiguous names stay unlinked", async () => {
    const j = await (await post([row({ yahooId: "300", playerName: "K. Murray", nbaTeam: "UTA", positions: "C" })])).json();
    expect(j).toMatchObject({ created: 1 });
    expect(getAllPlayerRecords(db).some((r) => r.player.id === "yahoo-k-murray-uta")).toBe(true);
    const amb = await (await post([row({ yahooId: "301", playerName: "J. Murray", nbaTeam: "XXX", positions: "C" })])).json();
    expect(amb.matched + amb.ambiguous).toBe(1);
  });

  it("survives a CSV reseed and changes the valuation of the player", async () => {
    const before = computeValuations(getAllPlayerRecords(db)).valuations["jamal-murray"].nineCat;
    await post([row({ yahooId: "5001", pts: 3000, ast: 700 })]);
    seedFromRecords(db, [makeRecord({ id: "jamal-murray", name: "Jamal Murray", positions: ["PG"], projection: { pts: 20 }, market: { yahooAdp: 30, rank: 30 } })]);
    const recs = getAllPlayerRecords(db);
    expect(recs.find((r) => r.player.id === "jamal-murray")!.projection).toMatchObject({ projectionSource: "yahoo-2026-27", pts: expect.closeTo(3000 / 70, 6) });
    expect(computeValuations(recs).valuations["jamal-murray"].nineCat).not.toBeCloseTo(before, 3);
    const api = (await (await playersGet()).json()) as { player: { id: string }; projection: { projectionSource: string } }[];
    expect(api.find((r) => r.player.id === "jamal-murray")!.projection.projectionSource).toBe("yahoo-2026-27");
  });

  it("recommendations reflect a new capture (cache invalidated)", async () => {
    seedFromRecords(db, Array.from({ length: 14 }, (_, i) => makeRecord({ id: `f${i}`, name: `Filler ${i}`, projection: { pts: 8 + i, reb: 3 + (i % 5), ast: 2 + (i % 4) }, market: { yahooAdp: 50 + i, rank: 50 + i } })));
    const d = createDraft(db, { teams: 2, userSlot: 1, rounds: 3 });
    const a = computeRecommendations(db, d.id)!;
    const sa = a.top.find((t) => t.playerId === "jamal-murray")!.score;
    await post([row({ yahooId: "5001", pts: 3200, reb: 900, ast: 900 })]);
    const b = computeRecommendations(db, d.id)!;
    expect(b.top.find((t) => t.playerId === "jamal-murray")!.score).not.toBe(sa);
  });

  it("validates the body and answers the preflight", async () => {
    expect((await post([{ yahooId: "abc", playerName: "x" }])).status).toBe(400);
    expect((await post([row({ fgPct: 71 })])).status).toBe(400);
    const bad = await projPost(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ season: "2025-26", view: "proj", rows: [] }) }));
    expect(bad.status).toBe(400);
    const o = projOptions(new Request("http://localhost/x", { method: "OPTIONS", headers: { origin: YAHOO } }));
    expect(o.status).toBe(204);
    expect(o.headers.get("access-control-allow-private-network")).toBe("true");
  });
});

describe("Yahoo id exact match in pick ingestion", () => {
  it("resolves by players.yahoo_player_key before names (the abbreviated name would be ambiguous)", () => {
    db.update(players).set({ yahooPlayerKey: "nba.p.4242" }).where(eq(players.id, "keegan-murray")).run();
    const d = createDraft(db, { teams: 2, userSlot: 1, rounds: 3 });
    // "J. Murray" alone would match Jamal; the id says it is Keegan
    const r = ingestDomPicks({ db, draftId: d.id, picks: [{ pick: 1, playerName: "J. Murray", yahooId: "4242" }] });
    expect(r.ingested).toBe(1);
    expect(r.draft.picks[0].playerId).toBe("keegan-murray");
    expect(r.autoResolved).toEqual([]);
  });
  it("placeholders created for unknown picks carry the yahoo key", () => {
    const d = createDraft(db, { teams: 2, userSlot: 1, rounds: 3 });
    const r = ingestDomPicks({ db, draftId: d.id, picks: [{ pick: 1, playerName: "Z. Nobody", nbaTeam: "UTA", yahooId: "777" }] });
    expect(r.autoResolved[0].resolution).toBe("placeholder");
    expect(db.select().from(players).where(eq(players.id, r.autoResolved[0].playerId)).get()!.yahooPlayerKey).toBe("nba.p.777");
  });
});

describe("Yahoo-tab alerts (app side)", () => {
  const st = (receivedAt: number, extra: Partial<BrowserStatus> = {}): BrowserStatus => ({ receivedAt, lastIngestAt: null, received: 0, highestPick: 0, totalIngested: 0, unmapped: null, mismatches: [], stoppedReason: null, conflict: null, ...extra });
  it("quiet after 15 s (amber), red after 45 s; only when enabled and the draft is active", () => {
    const base = { enabled: true, draftActive: true };
    expect(yahooAlert({ ...base, status: st(0), now: 14_000 }).kind).toBe("none");
    expect(yahooAlert({ ...base, status: st(0), now: 16_000 })).toMatchObject({ kind: "quiet", level: "amber", message: QUIET_MESSAGE });
    expect(yahooAlert({ ...base, status: st(0), now: 50_000 })).toMatchObject({ kind: "quiet", level: "red" });
    expect(yahooAlert({ ...base, enabled: false, status: st(0), now: 50_000 }).kind).toBe("none");
    expect(yahooAlert({ ...base, draftActive: false, status: st(0), now: 50_000 }).kind).toBe("none");
    expect(yahooAlert({ ...base, status: null, now: 20_000, sinceMs: 20_000 }).kind).toBe("quiet");
  });
  it("panel hidden / page hidden reports, cleared when the feed is back", () => {
    const base = { enabled: true, draftActive: true, now: 1000 };
    expect(yahooAlert({ ...base, status: st(900, { panel: "hidden", pageVisible: true }) }).kind).toBe("panel");
    expect(yahooAlert({ ...base, status: st(900, { panel: "picks", pageVisible: false }) }).kind).toBe("page-hidden");
    expect(yahooAlert({ ...base, status: st(900, { panel: "picks", pageVisible: true }) }).kind).toBe("none");
  });
});
