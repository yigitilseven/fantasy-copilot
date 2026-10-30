import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { getAllPlayerRecords } from "@/db/repository";
import { playerNews, playerStatusUpdates } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { gamesMissedUntil } from "@/engine/risk/calendar";
import { buildNameMatcher, matchNewsItem } from "@/integrations/news/match";
import { mergeReports } from "@/integrations/news/merge";
import { PROVIDERS } from "@/integrations/news/providers";
import type { NewsProvider, StatusReport } from "@/integrations/news/types";
import { getNewsStatus, newsRefreshDue, runNewsUpdate } from "@/integrations/news/update";
import { makeRecord } from "./fixtures";

const fx = (f: string) => fs.readFileSync(path.resolve(__dirname, "fixtures-news", f), "utf8");
const NOW = new Date("2026-10-07T14:00:00Z");
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "news-test-"));

const rep = (o: Partial<StatusReport>): StatusReport => ({ name: "X Y", status: "day-to-day", injury: null, estReturn: null, comment: null, source: "ESPN", reportedAt: null, ...o });

describe("name matching", () => {
  const m = buildNameMatcher([
    { id: "wemby", name: "Victor Wembanyama" }, { id: "jj", name: "Jaren Jackson Jr." }, { id: "cam", name: "Cam Thomas" },
    { id: "jw1", name: "Jalen Williams" }, { id: "jw2", name: "Jaylin Williams" }, { id: "kj", name: "Kevin Johnson" },
  ]);
  it("matches full names with accents, possessives and suffixes", () => {
    expect(m.match("Victor Wembanyama's block party")).toEqual(["wemby"]);
    expect(m.match("Jaren Jackson Jr. scores 30")).toEqual(["jj"]);
    expect(m.match("Cameron Thomas returns")).toEqual(["cam"]); // alias
  });
  it("never matches a bare common surname", () => {
    expect(m.match("Williams scored 20 and Johnson added 10")).toEqual([]);
    expect(m.match("Thomas had a big night")).toEqual([]);
  });
  it("'F. Last' only when initial+last is unique", () => {
    expect(m.match("V. Wembanyama exits early")).toEqual(["wemby"]);
    expect(m.match("J. Williams is questionable")).toEqual([]); // Jalen vs Jaylin
    expect(m.match("K. Johnson is out")).toEqual(["kj"]);
  });
  it("explicit playerName and text mentions combine", () => {
    expect(matchNewsItem(m, { title: "Victor Wembanyama: dominant", link: "l", source: "RotoWire", publishedAt: "x", playerName: "Victor Wembanyama" })).toEqual(["wemby"]);
  });
});

describe("mergeReports precedence", () => {
  it("most recent day wins; undated loses; fills missing return date from same-status reports", () => {
    const w = mergeReports([
      rep({ source: "RotoWire", status: "out", reportedAt: null }),
      rep({ source: "CBS", status: "day-to-day", reportedAt: "2026-10-05T00:00:00.000Z" }),
      rep({ source: "ESPN", status: "out", estReturn: "2026-11-01", reportedAt: "2026-10-06T10:00:00.000Z" }),
    ])!;
    expect(w).toMatchObject({ source: "ESPN", status: "out", estReturn: "2026-11-01" });
  });
  it("same day: more severe status, then source priority; fills estReturn", () => {
    const a = mergeReports([rep({ source: "ESPN", status: "day-to-day", reportedAt: "2026-10-06T10:00:00Z" }), rep({ source: "CBS", status: "out", estReturn: "2026-11-02", reportedAt: "2026-10-06T00:00:00Z" })])!;
    expect(a).toMatchObject({ source: "CBS", status: "out" });
    const b = mergeReports([rep({ source: "CBS", status: "out", reportedAt: "2026-10-06T00:00:00Z" }), rep({ source: "ESPN", status: "out", estReturn: "2026-11-02", reportedAt: "2026-10-06T10:00:00Z" })])!;
    expect(b).toMatchObject({ source: "ESPN", estReturn: "2026-11-02" });
    expect(mergeReports([])).toBeNull();
  });
});

describe("calendar math", () => {
  it("games missed at 3.45/week from the season start (preseason now)", () => {
    expect(gamesMissedUntil("2026-10-20", NOW)).toBe(0);
    expect(gamesMissedUntil("2026-11-01", NOW)).toBe(6); // 12 days
    expect(gamesMissedUntil("2026-12-20", NOW)).toBe(Math.round((61 * 3.45) / 7));
    expect(gamesMissedUntil("2027-07-01", NOW)).toBe(82);
  });
  it("in season counting starts today", () => {
    expect(gamesMissedUntil("2026-12-01", new Date("2026-11-17T12:00:00Z"))).toBe(Math.round((14 * 3.45) / 7));
  });
});

// ---------------------------------------------------------------- DB-level

function providerFrom(id: string, kind: "injuries" | "news", file: string, label: string, over: Partial<NewsProvider> = {}): NewsProvider {
  const base = PROVIDERS.find((p) => p.id === id)!;
  return { ...base, id, kind, label, url: `http://test/${id}`, ...over, parse: over.parse ?? ((t, n) => base.parse(t, n)) };
}
const okFetch = (files: Record<string, string>): typeof fetch => (async (url: string) => {
  const key = Object.keys(files).find((k) => String(url).endsWith(k));
  if (!key) return new Response("nope", { status: 500 });
  return new Response(files[key], { status: 200 });
}) as unknown as typeof fetch;

describe("runNewsUpdate", () => {
  let db: Db;
  const rec = (id: string, name: string, adp: number, risk: Record<string, unknown> = {}) => makeRecord({ id, name, market: { yahooAdp: adp, rank: adp }, risk: risk as never });
  const records = () => [
    rec("wiggins", "Aaron Wiggins", 120), rec("butler", "Jimmy Butler", 40), rec("veesaar", "Henri Veesaar", 200),
    rec("curry", "Stephen Curry", 20), rec("podz", "Brandin Podziemski", 90), rec("healthyguy", "Totally Healthy", 60),
    rec("csvout", "Csv Injured", 70, { currentStatus: "out", projectedGames: 40 }),
  ];
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, records());
  });
  const files = { "espn-injuries": fx("espn-injuries.json"), "cbs-injuries": fx("cbs-injuries.html"), "rotowire-injuries": fx("rotowire-injuries.json"), "yahoo-rss": fx("yahoo-rss.xml"), "rotowire-rss": fx("rotowire-rss.xml") };
  const providers = () => [
    providerFrom("espn-injuries", "injuries", "", "ESPN"), providerFrom("cbs-injuries", "injuries", "", "CBS"), providerFrom("rotowire-injuries", "injuries", "", "RotoWire"),
    providerFrom("yahoo-rss", "news", "", "Yahoo Sports"), providerFrom("rotowire-rss", "news", "", "RotoWire"),
  ];
  // The trimmed fixtures have < 5 rows for CBS/RotoWire; the guard is covered separately, so relax it with a wrapper.
  const run = (o: Partial<Parameters<typeof runNewsUpdate>[1]> = {}) => runNewsUpdate(db, { providers: providers(), fetchImpl: okFetch(files), cacheDir, attempts: 1, now: NOW, ...o });

  it("applies merged statuses, reduces projected games, attaches news, records sources", async () => {
    const s = await run();
    const by = Object.fromEntries(getAllPlayerRecords(db, NOW.getTime()).map((r) => [r.player.id, r]));
    expect(by.butler.risk).toMatchObject({ currentStatus: "out", estReturn: "2027-01-02", statusSource: "ESPN" }); // same-day tie CBS/ESPN -> source priority
    expect(by.butler.risk.projectedGames).toBe(75 - gamesMissedUntil("2027-01-02", NOW));
    expect(by.butler.risk.gamesMissed).toBe(gamesMissedUntil("2027-01-02", NOW));
    expect(by.veesaar.risk).toMatchObject({ currentStatus: "out-for-season", projectedGames: 0 });
    expect(by.wiggins.risk.currentStatus).toBe("day-to-day");
    expect(by.wiggins.risk.projectedGames).toBe(75); // DTD: no reduction
    expect(s.statusChanges.map((c) => c.name)).toContain("Jimmy Butler");
    expect(s.sources.filter((x) => x.ok).length).toBe(5);
    expect(getNewsStatus(db).sources).toHaveLength(5);
    // news: ESPN injury note / RotoWire title prefix
    expect(by.wiggins.risk.latestNews?.length).toBeGreaterThan(0);
    expect(by.podz.risk.latestNews?.[0].title).toMatch(/Podziemski/);
    expect(by.podz.risk.latestNews!.length).toBeLessThanOrEqual(3);
  });

  it("is idempotent: a second run writes no rows and no duplicate news", async () => {
    await run();
    const n1 = db.select().from(playerStatusUpdates).all().length;
    const w1 = db.select().from(playerNews).all().length;
    const s2 = await run({ now: new Date(NOW.getTime() + 3600_000) });
    expect(db.select().from(playerStatusUpdates).all().length).toBe(n1);
    expect(db.select().from(playerNews).all().length).toBe(w1);
    expect(s2.statusChanges).toEqual([]);
    expect(s2.newsInserted).toBe(0);
  });

  it("clears players that vanish from all successful reports (and records source 'cleared'), incl. CSV-only statuses", async () => {
    await run();
    expect(getAllPlayerRecords(db, NOW.getTime()).find((r) => r.player.id === "csvout")!.risk.currentStatus).toBe("healthy"); // CSV said out, no report lists him
    // Butler disappears from every report next day
    const stripped = {
      ...files,
      "espn-injuries": JSON.stringify({ injuries: [{ displayName: "T", injuries: JSON.parse(files["espn-injuries"]).injuries.flatMap((t: { injuries: { athlete: { displayName: string } }[] }) => t.injuries).filter((i: { athlete: { displayName: string } }) => !/Butler/.test(i.athlete.displayName)) }] }),
      "rotowire-injuries": JSON.stringify(JSON.parse(files["rotowire-injuries"]).filter((r: { player: string }) => !/Butler/.test(r.player))),
      "cbs-injuries": files["cbs-injuries"].replace(/<tr class="TableBase-bodyTr">(?:(?!<\/tr>)[\s\S])*Butler[\s\S]*?<\/tr>/, ""),
    };
    const s = await run({ fetchImpl: okFetch(stripped), now: new Date(NOW.getTime() + 86_400_000) });
    const butler = getAllPlayerRecords(db, NOW.getTime()).find((r) => r.player.id === "butler")!;
    expect(butler.risk).toMatchObject({ currentStatus: "healthy", statusSource: "cleared" });
    expect(butler.risk.projectedGames).toBe(75); // back to the CSV value
    expect(s.cleared).toBeGreaterThanOrEqual(1);
    expect(db.select().from(playerStatusUpdates).where(eq(playerStatusUpdates.playerId, "butler")).all().map((r) => r.source)).toContain("cleared");
  });

  it("never clears when every injury source failed; failures keep last good data and record the error", async () => {
    await run();
    const before = getAllPlayerRecords(db, NOW.getTime()).find((r) => r.player.id === "butler")!.risk;
    const s = await run({ fetchImpl: okFetch({}) }); // every request 500s
    expect(s.sources.every((x) => !x.ok)).toBe(true);
    expect(s.cleared).toBe(0);
    expect(getAllPlayerRecords(db, NOW.getTime()).find((r) => r.player.id === "butler")!.risk).toMatchObject({ currentStatus: before.currentStatus, estReturn: before.estReturn });
    const st = getNewsStatus(db);
    expect(st.sources.every((x) => x.lastError && x.lastSuccessAt)).toBe(true);
    expect(newsRefreshDue(st, NOW.getTime() + 7 * 3600_000)).toBe(true);
    expect(newsRefreshDue(st, NOW.getTime() + 3600_000)).toBe(false);
  });

  it("a partial outage does not clear players only the failed source reported", async () => {
    await run();
    // only RotoWire answers (it lacks Butler/Veesaar); their latest update came from CBS/ESPN, which did not answer
    const s = await run({ fetchImpl: okFetch({ "rotowire-injuries": files["rotowire-injuries"] }), now: new Date(NOW.getTime() + 3600_000) });
    expect(s.sources.find((x) => x.id === "rotowire-injuries")!.ok).toBe(true);
    const by = Object.fromEntries(getAllPlayerRecords(db, NOW.getTime()).map((r) => [r.player.id, r]));
    expect(by.butler.risk.currentStatus).toBe("out");
    expect(by.veesaar.risk.currentStatus).toBe("out-for-season");
  });

  it("a CSV reseed does not clobber ingested status or news", async () => {
    await run();
    seedFromRecords(db, records()); // reseed rewrites player_risk from the CSV
    const by = Object.fromEntries(getAllPlayerRecords(db, NOW.getTime()).map((r) => [r.player.id, r]));
    expect(by.butler.risk.currentStatus).toBe("out");
    expect(by.veesaar.risk.currentStatus).toBe("out-for-season");
    expect(by.podz.risk.latestNews?.length).toBeGreaterThan(0);
  });

  it("an 'out' whose return date has passed is day-to-day", async () => {
    await run();
    const later = new Date("2027-02-01T12:00:00Z").getTime();
    expect(getAllPlayerRecords(db, later).find((r) => r.player.id === "butler")!.risk.currentStatus).toBe("day-to-day");
  });

  it("rejects an injury source with too few rows (never used for clearing)", async () => {
    const s = await runNewsUpdate(db, { providers: [providerFrom("rotowire-injuries", "injuries", "", "RotoWire")], fetchImpl: okFetch({ "rotowire-injuries": JSON.stringify([{ player: "A B", status: "Out" }]) }), cacheDir, attempts: 1, now: NOW });
    expect(s.sources[0].ok).toBe(false);
    expect(s.sources[0].error).toMatch(/only 1 injury rows/);
  });
});
