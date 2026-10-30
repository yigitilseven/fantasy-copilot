import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAdpFile, parseFantasyProsAdp, parseHashtagAdp, parsePositionList } from "@/integrations/projections/adp-sources";
import { loadPlayerRecordsFromCsv, parseCsv } from "@/integrations/projections/csv";
import { cachedText, fetchTextWithRetry } from "@/integrations/projections/fetch-cache";
import { nameKey, normalizeName } from "@/integrations/projections/names";
import { buildRealDataset, nineCatZSum, runRealImport } from "@/integrations/projections/real-data";
import { readExisting } from "@/integrations/projections/shared";
import {
  blendStats, effectiveGp, mapNbaPosition, nbaStatsUrl, parseBbrefPerGame, parseNbaLeagueStats, parseNbaPlayerIndex, parseStatsCsv,
} from "@/integrations/projections/stats-sources";

const fx = (f: string) => fs.readFileSync(path.resolve(__dirname, "fixtures-real", f), "utf8");
const latest = () => parseNbaLeagueStats(JSON.parse(fx("nba-latest.json")));
const prior = () => parseNbaLeagueStats(JSON.parse(fx("nba-prior.json")));
const emptyExisting = { projections: new Map(), injuries: new Map() };
const NOW = "2026-10-07T00:00:00Z";

describe("name normalization", () => {
  it("strips accents, punctuation, suffixes", () => {
    expect(normalizeName("Nikola Jokić")).toBe("nikola jokic");
    expect(normalizeName("Jaren Jackson Jr.")).toBe("jaren jackson");
    expect(normalizeName("Trey Murphy III")).toBe("trey murphy");
    expect(normalizeName("Shai Gilgeous-Alexander")).toBe("shai gilgeous alexander");
    expect(normalizeName("De'Aaron Fox")).toBe("deaaron fox");
    expect(normalizeName("P.J. Washington")).toBe("pj washington");
    expect(normalizeName("Marvin Bagley III")).toBe("marvin bagley");
  });
  it("resolves nickname aliases both ways", () => {
    for (const [a, b] of [["Nic Claxton", "Nicolas Claxton"], ["Herb Jones", "Herbert Jones"], ["Alex Sarr", "Alexandre Sarr"], ["Cam Thomas", "Cameron Thomas"]])
      expect(nameKey(a)).toBe(nameKey(b));
  });
});

describe("position mapping", () => {
  it("maps NBA.com / BBRef strings to Yahoo-ish eligibility", () => {
    expect(mapNbaPosition("G")).toEqual(["PG", "SG"]);
    expect(mapNbaPosition("F")).toEqual(["SF", "PF"]);
    expect(mapNbaPosition("C")).toEqual(["C"]);
    expect(mapNbaPosition("G-F")).toEqual(["SG", "SF"]);
    expect(mapNbaPosition("F-C")).toEqual(["PF", "C"]);
    expect(mapNbaPosition("C-F")).toEqual(["C", "PF"]);
    expect(mapNbaPosition("PG")).toEqual(["PG"]);
    expect(mapNbaPosition("SG-SF")).toEqual(["SG", "SF"]);
    expect(mapNbaPosition("")).toEqual([]);
    expect(mapNbaPosition("X")).toEqual([]);
  });
  it("parses ADP-site position lists", () => {
    expect(parsePositionList("PG,SF,SG")).toEqual(["PG", "SG", "SF"]);
    expect(parsePositionList("G/F")).toEqual(["PG", "SG", "SF", "PF"]);
  });
});

describe("stats parsing + blending", () => {
  it("parses NBA.com resultSets and the player index", () => {
    const rows = latest();
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ name: "Nikola Jokić", team: "DEN", age: 31 });
    expect(rows[0].line).toMatchObject({ gp: 60, minutes: 34, fgm: 10, fta: 6, threePm: 2, reb: 12 });
    expect(parseNbaPlayerIndex(JSON.parse(fx("nba-playerindex.json"))).get(nameKey("Jaren Jackson Jr."))).toBe("F-C");
    expect(() => parseNbaLeagueStats({ nope: 1 })).toThrow(/resultSets/);
  });
  it("builds the request URL with the required empty params", () => {
    const u = nbaStatsUrl("2025-26");
    expect(u).toContain("Season=2025-26");
    expect(u).toContain("SeasonType=Regular%20Season");
    expect(u).toContain("PerMode=PerGame");
    expect(u).toContain("MeasureType=Base");
    expect(u).toContain("LeagueID=00");
  });
  it("blends 0.7 latest + 0.3 prior when prior GP >= 20", () => {
    const l = latest()[0].line, p = prior()[0].line;
    const b = blendStats(l, p)!;
    expect(b.source).toBe("nba_stats_blend");
    expect(b.line.pts).toBeCloseTo(0.7 * l.pts + 0.3 * p.pts, 9);
    expect(b.line.fgm).toBeCloseTo(0.7 * 10 + 0.3 * 11, 9);
    expect(b.line.fga).toBeCloseTo(0.7 * 18 + 0.3 * 19, 9);
    expect(b.line.gp).toBe(60);
    // pts stays consistent with its components after blending
    expect(b.line.pts).toBeCloseTo(2 * b.line.fgm + b.line.threePm + b.line.ftm, 9);
  });
  it("uses latest alone when prior is short/missing, prior alone when latest sample is tiny", () => {
    const [jokic, , , tiny, injured, short] = latest();
    const pj = prior();
    expect(blendStats(short.line, pj[3].line)!.source).toBe("nba_stats_latest"); // prior GP 12
    expect(blendStats(jokic.line, null)!.source).toBe("nba_stats_latest");
    const b = blendStats(injured.line, pj[2].line)!; // latest 8 GP, prior 73 GP
    expect(b.source).toBe("nba_stats_prior");
    expect(b.line.pts).toBeCloseTo(pj[2].line.pts, 9);
    expect(blendStats(tiny.line, null)).toBeNull();
  });
  it("effective GP weights latest 0.6 / prior 0.4", () => {
    expect(effectiveGp(60, 80)).toBeCloseTo(68);
    expect(effectiveGp(60, null)).toBe(60);
    expect(effectiveGp(null, null)).toBeNull();
  });
  it("parses a NBA.com-style CSV with header aliases", () => {
    const rows = parseStatsCsv("PLAYER,TEAM,AGE,GP,MIN,FGM,FGA,3PM,FTM,FTA,REB,AST,STL,BLK,TOV,PTS\nA B,LAL,25,50,30,5,10,1,2,3,4,5,1,1,2,13\n");
    expect(rows[0]).toMatchObject({ name: "A B", team: "LAL" });
    expect(rows[0].line.threePm).toBe(1);
  });
  it("parses Basketball-Reference tables (precise csk values, multi-team via the TOT row)", () => {
    const rows = parseBbrefPerGame(fx("bbref.html"));
    expect(rows.map((r) => r.name)).toEqual(["Nikola Jokić", "Traded Guy"]);
    expect(rows[0].line.gp).toBe(60);
    expect(rows[1].line.gp).toBe(50); // TOT row stats
    expect(rows[1].team).toBe("BBB"); // last team
    expect(rows[1].pos).toBe("SG");
  });
});

describe("ADP parsing", () => {
  it("FantasyPros: uses the Yahoo column, falls back to AVG, skips rows with neither", () => {
    const e = parseFantasyProsAdp(fx("fantasypros.html"));
    expect(e.map((x) => x.name)).toEqual(["Nikola Jokic", "Nic Claxton", "Jaren Jackson Jr.", "Injured Star", "Rookie Guy"]);
    expect(e[0]).toMatchObject({ adp: 2, team: "DEN", positions: ["C"], usedAverage: false });
    expect(e[2].positions).toEqual(["PF", "C"]);
    expect(e[4]).toMatchObject({ adp: 77, usedAverage: true });
  });
  it("Hashtag: Yahoo ADP attribute, positions from pills, falls back to blend", () => {
    const e = parseHashtagAdp(fx("hashtag.html"));
    expect(e.map((x) => [x.name, x.adp, x.usedAverage])).toEqual([["Nikola Jokic", 1.6, false], ["Nic Claxton", 21.1, false], ["Rookie Guy", 80, true]]);
    expect(e[2].positions).toEqual(["PG", "SG"]);
  });
  it("parseAdpFile detects HTML flavours and CSV", () => {
    expect(parseAdpFile(fx("hashtag.html")).source).toBe("hashtag");
    expect(parseAdpFile(fx("fantasypros.html")).source).toBe("fantasypros");
    const c = parseAdpFile("Player,ADP,Team,Pos\nB B,5.5,LAL,PG\nA A,2,BOS,C\n");
    expect(c.source).toBe("file");
    expect(c.entries.map((x) => x.name)).toEqual(["A A", "B B"]);
  });
});

describe("join + dataset", () => {
  const build = (existing = emptyExisting) =>
    buildRealDataset({ adp: parseFantasyProsAdp(fx("fantasypros.html")), latest: latest(), prior: prior(), nbaIndex: parseNbaPlayerIndex(JSON.parse(fx("nba-playerindex.json"))), existing, nowIso: NOW, includeUnranked: false });

  it("joins accented / aliased / suffixed names and orders by Yahoo ADP", () => {
    const d = build();
    expect(d.projections.map((p) => p.id)).toEqual(["nikola-jokic", "nicolas-claxton", "jaren-jackson-jr", "injured-star", "rookie-guy"]);
    expect(d.projections[0].name).toBe("Nikola Jokić");
    expect(d.adp.map((a) => a.yahoo_adp)).toEqual(["2", "20.5", "30", "40", "77"]);
    expect(d.adp.map((a) => a.rank)).toEqual(["1", "2", "3", "4", "5"]);
    const sources = Object.fromEntries(d.sources.map((s) => [s.player_id, s.source]));
    expect(sources).toMatchObject({ "nikola-jokic": "nba_stats_blend", "nicolas-claxton": "nba_stats_blend", "jaren-jackson-jr": "nba_stats_latest", "injured-star": "nba_stats_prior", "rookie-guy": "adp_template" });
    expect(d.adpUnmatched).toEqual([{ name: "Rookie Guy", adp: 77, resolvedAs: "adp_template" }]);
    // Prior Short has stats (40 GP, 25 MPG) but its ADP row had no usable value; Tiny Sample is below the GP floor
    expect(d.statsUnmatched.map((s) => s.name)).toEqual(["Prior Short"]);
  });
  it("positions: existing CSV > ADP site > NBA index; team from ADP site", () => {
    const existing = {
      projections: new Map([["old-id", { id: "old-id", name: "Jaren Jackson", nba_team: "MEM", positions: "PF", age: "26", games: "70", minutes: "30", pts: "20", fgm: "7", fga: "15", ftm: "4", fta: "5", three_pm: "2", reb: "5", ast: "2", stl: "1", blk: "1.5", tov: "2" }]]),
      injuries: new Map([["old-id", { player_id: "old-id", projected_games: "70", current_status: "day-to-day", injury_history_score: "0.55", rest_risk: "0.3", availability_score: "0.9", major_injury_history: "true", updated_at: "x" }]]),
    };
    const d = build(existing);
    const jj = d.projections.find((p) => p.id === "old-id")!;
    expect(jj.positions).toBe("PF");
    expect(d.counts.reusedIds).toBe(1);
    const inj = d.injuries.find((i) => i.player_id === "old-id")!;
    expect(inj).toMatchObject({ current_status: "day-to-day", injury_history_score: "0.55", rest_risk: "0.30", major_injury_history: "true" });
    expect(d.projections.find((p) => p.id === "nikola-jokic")!.positions).toBe("C");
  });
  it("risk: availability from two seasons; a missed season counts as 0 GP", () => {
    const d = build();
    const inj = Object.fromEntries(d.injuries.map((i) => [i.player_id, i]));
    expect(Number(inj["nikola-jokic"].availability_score)).toBeCloseTo((0.6 * 60 + 0.4 * 80) / 82, 2);
    expect(Number(inj["jaren-jackson-jr"].availability_score)).toBeCloseTo(72 / 82, 2);
    expect(Number(inj["injured-star"].availability_score)).toBeCloseTo((0.6 * 8 + 0.4 * 73) / 82, 2);
    for (const p of d.projections) expect(inj[p.id].projected_games).toBe(p.games);
  });
  it("template line is internally consistent", () => {
    const p = build().projections.find((r) => r.id === "rookie-guy")!;
    expect(Math.abs(Number(p.pts) - (2 * Number(p.fgm) + Number(p.three_pm) + Number(p.ftm)))).toBeLessThan(0.02);
    expect(Number(p.fgm)).toBeLessThan(Number(p.fga));
    expect(Number(p.ftm)).toBeLessThanOrEqual(Number(p.fta));
  });
});

describe("stats-only (unranked) players", () => {
  const nbaIndex = new Map([...parseNbaPlayerIndex(JSON.parse(fx("nba-playerindex.json"))), [nameKey("Prior Short"), "G"], [nameKey("Tiny Sample"), "F"]]);
  const build = (extra: Partial<Parameters<typeof buildRealDataset>[0]> = {}) =>
    buildRealDataset({ adp: parseFantasyProsAdp(fx("fantasypros.html")), latest: latest(), prior: prior(), nbaIndex, existing: emptyExisting, nowIso: NOW, ...extra });

  it("appends qualifying stats-only players after the max ADP, 1.0 apart, with the usual blend + std dev", () => {
    const d = build();
    expect(d.projections.map((p) => p.id)).toEqual(["nikola-jokic", "nicolas-claxton", "jaren-jackson-jr", "injured-star", "rookie-guy", "prior-short"]);
    const ps = d.adp.find((a) => a.player_id === "prior-short")!;
    expect(ps).toMatchObject({ yahoo_adp: "78", rank: "6" }); // max universe ADP 77 + 1.0
    expect(Number(ps.adp_std_dev)).toBeCloseTo(Math.min(22, 0.8 + 0.12 * 78), 2);
    expect(d.sources.find((s) => s.player_id === "prior-short")!.source).toBe("nba_stats_latest"); // prior GP 12 < 20
    expect(d.projections.find((p) => p.id === "prior-short")).toMatchObject({ nba_team: "UTA", positions: "PG/SG", pts: "13.00" });
    expect(d.counts.unranked).toBe(1);
    expect(d.statsUnmatched).toEqual([]);
  });
  it("Tiny Sample (5 GP) never qualifies; --min-gp / --min-min override; flag disables", () => {
    expect(build().projections.some((p) => p.id === "tiny-sample")).toBe(false);
    expect(build({ includeUnranked: false }).projections).toHaveLength(5);
    expect(build({ minMin: 26 }).counts.unranked).toBe(0); // Prior Short plays 25 MPG
    const lowGp = build({ minGp: 5, minMin: 12 });
    // 5 GP qualifies by the floor but is too thin for any projection (latest < 15 GP, no prior)
    expect(lowGp.counts.unrankedSkipped).toBe(1);
    expect(lowGp.skipped.some((s) => s.name === "Tiny Sample")).toBe(true);
  });
  it("orders stats-only players by 9-cat z-sum and keeps ADP strictly increasing", () => {
    const l = latest();
    const extra = (name: string, pts: number) => ({ ...l[5], name, line: { ...l[5].line, pts, fgm: pts / 2.2, fga: pts / 1.1 } });
    const d = build({ latest: [...l, extra("Zed Good", 25), extra("Abe Meh", 6)], nbaIndex: new Map([...nbaIndex, [nameKey("Zed Good"), "G"], [nameKey("Abe Meh"), "G"]]) });
    const ids = d.projections.map((p) => p.id);
    expect(ids.indexOf("zed-good")).toBeLessThan(ids.indexOf("prior-short"));
    expect(ids.indexOf("prior-short")).toBeLessThan(ids.indexOf("abe-meh"));
    const adps = d.adp.map((a) => Number(a.yahoo_adp));
    expect(adps.every((v, i) => i === 0 || v > adps[i - 1])).toBe(true);
    expect(adps.slice(5)).toEqual([78, 79, 80]);
  });
  it("nineCatZSum favours the better line", () => {
    const z = nineCatZSum([latest()[0].line, latest()[3].line, latest()[1].line]);
    expect(z[0]).toBeGreaterThan(z[2]);
  });
});

describe("fetching + cache", () => {
  const ok = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  it("retries then succeeds; gives up with the last error", async () => {
    let n = 0;
    const flaky = (async () => (++n < 3 ? new Response("no", { status: 503 }) : new Response("fine"))) as unknown as typeof fetch;
    expect(await fetchTextWithRetry("https://x.test/a", {}, { retries: 3, fetchImpl: flaky })).toBe("fine");
    n = -10;
    await expect(fetchTextWithRetry("https://x.test/a", {}, { retries: 2, fetchImpl: flaky })).rejects.toThrow(/HTTP 503/);
  }, 20_000);
  it("times out", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchTextWithRetry("https://x.test/a", {}, { retries: 1, timeoutMs: 20, fetchImpl: hang })).rejects.toThrow(/timeout/);
  });
  it("caches, honours --refresh and --offline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-cache-"));
    await expect(cachedText("a.txt", "https://x.test/a", {}, { cacheDir: dir, offline: true })).rejects.toThrow(/offline/);
    expect((await cachedText("a.txt", "https://x.test/a", {}, { cacheDir: dir, fetchImpl: ok("v1") })).fromCache).toBe(false);
    expect(await cachedText("a.txt", "https://x.test/a", {}, { cacheDir: dir, fetchImpl: ok("v2") })).toEqual({ text: "v1", fromCache: true });
    expect((await cachedText("a.txt", "https://x.test/a", {}, { cacheDir: dir, refresh: true, fetchImpl: ok("v2") })).text).toBe("v2");
    expect((await cachedText("a.txt", "https://x.test/a", {}, { cacheDir: dir, offline: true })).text).toBe("v2");
    await expect(cachedText("b.txt", "https://x.test/b", {}, { cacheDir: dir, fetchImpl: ok("bad") }, () => { throw new Error("invalid"); })).rejects.toThrow("invalid");
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(false);
  });
});

describe("runRealImport end to end (offline)", () => {
  it("writes four CSVs that load, backs up old ones, and validates", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-run-"));
    fs.writeFileSync(path.join(dir, "projections.csv"), "id,name\nold,Old\n");
    const s = await runRealImport({
      dataDir: dir, cacheDir: path.join(dir, "cache"), endYear: 2026, offline: true,
      statsFile: path.resolve(__dirname, "fixtures-real/nba-latest.json"), priorStatsFile: path.resolve(__dirname, "fixtures-real/nba-prior.json"),
      adpFile: path.resolve(__dirname, "fixtures-real/fantasypros.html"), now: new Date("2026-10-07T10:00:00Z"),
    });
    expect(s.stats.provider).toBe("file");
    expect(s.adpSource).toBe("fantasypros");
    expect(s.backupDir && fs.existsSync(path.join(s.backupDir, "projections.csv"))).toBe(true);
    const records = loadPlayerRecordsFromCsv(dir);
    expect(records).toHaveLength(5);
    expect(records[0].player.name).toBe("Nikola Jokić");
    expect(parseCsv(fs.readFileSync(path.join(dir, "projection-sources.csv"), "utf8")).map((r) => r.source)).toContain("adp_template");
    expect(readExisting(dir).projections.size).toBe(5);
  });
});
