import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adpStdDev, assignAdp, deriveRisk, mapPositions, mapStatus, mapTeam, slugify } from "@/integrations/yahoo/heuristics";
import { ADP_COLUMNS, INJURY_COLUMNS, PROJECTION_COLUMNS, adpTemplateLine, buildDataset, probeProjections, runImport, toCsv } from "@/integrations/yahoo/import";
import { loadPlayerRecordsFromCsv, parseCsv } from "@/integrations/projections/csv";
import { detectScale, parseMadeAtt, projectionUsable, statsToPerGame } from "@/integrations/yahoo/stats";
import { fakeGet } from "./yahoo-helpers";

describe("stat id -> per-game conversion", () => {
  const totals = { "0": "70", "2": "2380", "9004003": "800/1420", "5": ".563", "9007006": "420/510", "8": ".824", "10": "95", "12": "2115", "15": "880", "16": "700", "17": "120", "18": "55", "19": "210" };
  it("parses made/attempted strings", () => {
    expect(parseMadeAtt("800/1420")).toEqual([800, 1420]);
    expect(parseMadeAtt("1,200 / 2,000")).toEqual([1200, 2000]);
    expect(parseMadeAtt("-")).toBeNull();
    expect(parseMadeAtt(undefined)).toBeNull();
  });
  it("divides totals by GP", () => {
    const { line, scale } = statsToPerGame(totals);
    expect(scale).toBe("totals");
    expect(line!.gp).toBe(70);
    expect(line!.fgm).toBeCloseTo(800 / 70, 6);
    expect(line!.fga).toBeCloseTo(1420 / 70, 6);
    expect(line!.ftm).toBeCloseTo(6, 6);
    expect(line!.pts).toBeCloseTo(2115 / 70, 6);
    expect(line!.threePm).toBeCloseTo(95 / 70, 6);
    expect(line!.minutes).toBeCloseTo(34, 6);
    expect(line!.tov).toBeCloseTo(3, 6);
  });
  it("detects values that are already per-game", () => {
    const perGame = { ...totals, "9004003": "11.3/19.8", "9007006": "6.1/7.3", "12": "29.0", "10": "2.0", "15": "12.5" };
    expect(detectScale(perGame)).toBe("per_game");
    const { line } = statsToPerGame(perGame);
    expect(line!.pts).toBeCloseTo(29, 6);
    expect(line!.fgm).toBeCloseTo(11.3, 6);
  });
  it("handles '-' and unusable lines", () => {
    expect(statsToPerGame({ ...totals, "19": "-", "18": "-" }).line).toMatchObject({ tov: 0, blk: 0 });
    expect(statsToPerGame({ ...totals, "9004003": "-" }).line).toBeNull();
    expect(statsToPerGame({ ...totals, "12": "-" }).line).toBeNull();
    expect(statsToPerGame({ ...totals, "0": "-" }).line).toBeNull();
    expect(statsToPerGame({ ...totals, "0": "3" }).reason).toMatch(/3 GP/);
    expect(statsToPerGame({}).line).toBeNull();
    expect(statsToPerGame(null).line).toBeNull();
    expect(statsToPerGame({ ...totals, "2": "-" }).line!.minutes).toBeNull();
  });
  it("projectionUsable", () => {
    expect(projectionUsable(totals)).toBe(true);
    expect(projectionUsable({})).toBe(false);
    expect(projectionUsable(null)).toBe(false);
    expect(projectionUsable({ ...totals, "12": "-" })).toBe(false);
  });
});

describe("heuristics", () => {
  it("slugs and teams and positions", () => {
    expect(slugify("Jaren Jackson Jr.")).toBe("jaren-jackson-jr");
    expect(slugify("Luka Dončić")).toBe("luka-doncic");
    expect(slugify("De'Aaron Fox")).toBe("deaaron-fox");
    expect(mapTeam("GS")).toBe("GSW");
    expect(mapTeam("Den")).toBe("DEN");
    expect(mapTeam(null)).toBeNull();
    expect(mapPositions({ eligiblePositions: ["PG", "SG", "G", "Util", "IL"], displayPosition: null })).toEqual(["PG", "SG"]);
    expect(mapPositions({ eligiblePositions: [], displayPosition: "SF,PF" })).toEqual(["SF", "PF"]);
    expect(mapPositions({ eligiblePositions: ["Util"], displayPosition: "Util" })).toEqual([]);
  });
  it("status mapping", () => {
    expect(mapStatus(null, null)).toBe("healthy");
    expect(mapStatus("GTD", null)).toBe("day-to-day");
    expect(mapStatus("DTD", null)).toBe("day-to-day");
    expect(mapStatus("O", null)).toBe("out");
    expect(mapStatus("INJ", "Knee: out for the season")).toBe("out-for-season");
    expect(mapStatus("INJ", "Ankle")).toBe("out");
    expect(mapStatus("NA", null)).toBe("out");
    expect(mapStatus("SUSP", null)).toBe("out");
  });
  it("adp std dev grows then caps at 22", () => {
    expect(adpStdDev(1)).toBeCloseTo(0.92, 6);
    expect(adpStdDev(50)).toBeCloseTo(6.8, 6);
    expect(adpStdDev(300)).toBe(22);
  });
  it("assignAdp: fallback beyond max, strictly increasing, rank order", () => {
    const out = assignAdp([
      { key: "a", orIndex: 0, adp: 5 },
      { key: "b", orIndex: 1, adp: 5 }, // tie
      { key: "c", orIndex: 2, adp: null },
      { key: "d", orIndex: 3, adp: 2 },
      { key: "e", orIndex: 4, adp: null },
    ]);
    expect(out.map((o) => o.key)).toEqual(["d", "a", "b", "c", "e"]);
    expect(out.map((o) => o.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(out.map((o) => o.adp)).toEqual([2, 5, 5.01, 6.5, 8]);
    expect(out.filter((o) => o.fallback).map((o) => o.key)).toEqual(["c", "e"]);
    for (let i = 1; i < out.length; i++) expect(out[i].adp).toBeGreaterThan(out[i - 1].adp);
  });
  it("deriveRisk", () => {
    const base = deriveRisk({ lastSeasonGp: 82, status: null, injuryNote: null });
    expect(base).toMatchObject({ availabilityScore: 1, projectedGames: 76, currentStatus: "healthy", injuryHistoryScore: 0, majorInjuryHistory: false, restRisk: 0.1 });
    const mid = deriveRisk({ lastSeasonGp: 60, status: "GTD", injuryNote: null });
    expect(mid.availabilityScore).toBe(0.73);
    expect(mid.projectedGames).toBe(Math.round((60 * 0.6 + 28) * 0.97));
    expect(mid.currentStatus).toBe("day-to-day");
    expect(mid.injuryHistoryScore).toBe(0.27);
    const out = deriveRisk({ lastSeasonGp: 70, status: "O", injuryNote: null });
    expect(out.projectedGames).toBeLessThan(deriveRisk({ lastSeasonGp: 70, status: null, injuryNote: null }).projectedGames);
    const blended = deriveRisk({ lastSeasonGp: 41, status: null, injuryNote: null, existing: { injuryHistoryScore: 0.9, majorInjuryHistory: true, restRisk: 0.3 } });
    expect(blended.injuryHistoryScore).toBe(0.7); // (0.5 + 0.9)/2
    expect(blended).toMatchObject({ majorInjuryHistory: true, restRisk: 0.3 });
    expect(deriveRisk({ lastSeasonGp: 200, status: null, injuryNote: null }).availabilityScore).toBe(1);
  });
});

const EXISTING_PROJ = `${PROJECTION_COLUMNS.join(",")}
shai-gilgeous-alexander,,Shai Gilgeous-Alexander,OKC,PG/SG,28,72,34.0,31.9,11.3,21.0,8.0,9.0,1.3,4.5,6.3,1.9,1.0,2.4
`;
const EXISTING_ADP = `${ADP_COLUMNS.join(",")}\nshai-gilgeous-alexander,3.5,1.1,1\n`;
const EXISTING_INJ = `${INJURY_COLUMNS.join(",")}\nshai-gilgeous-alexander,72,healthy,0.20,0.13,0.85,true,2026-10-01T00:00:00Z\n`;

function tmpData(withExisting = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yahoo-import-"));
  if (withExisting) {
    fs.writeFileSync(path.join(dir, "projections.csv"), EXISTING_PROJ);
    fs.writeFileSync(path.join(dir, "yahoo-adp.csv"), EXISTING_ADP);
    fs.writeFileSync(path.join(dir, "injuries.csv"), EXISTING_INJ);
  }
  return dir;
}

describe("runImport (offline, fixtures)", () => {
  it("auto falls back to last_season when projected_season is empty; writes loadable CSVs and a backup", async () => {
    const dir = tmpData();
    const { get, calls } = fakeGet();
    const s = await runImport({ get, dataDir: dir, now: new Date("2026-10-07T12:00:00Z") });
    expect(s.sourceUsed).toBe("last_season");
    expect(calls.some((c) => c.includes("type=projected_season"))).toBe(true);
    // Flagg (rookie, no stats, ADP 41.5) stays on the board via the ADP template
    expect(s.dataset.skipped).toEqual([]);
    expect(s.counts).toEqual({ fetched: 5, written: 5 });
    expect(s.dataset.stats).toMatchObject({ fromLastSeason: 4, fromAdpTemplate: 1, fromExistingCsv: 0 });
    expect(parseCsv(fs.readFileSync(path.join(dir, "projection-sources.csv"), "utf8"))).toEqual([
      { player_id: "nikola-jokic", source: "last_season" },
      { player_id: "shai-gilgeous-alexander", source: "last_season" },
      { player_id: "victor-wembanyama", source: "last_season" },
      { player_id: "cooper-flagg", source: "adp_template" },
      { player_id: "kawhi-leonard", source: "last_season" },
    ]);
    expect(s.backupDir).toContain("backup-2026-10-07T12-00-00-000Z");
    expect(fs.readFileSync(path.join(s.backupDir!, "projections.csv"), "utf8")).toBe(EXISTING_PROJ);

    // The written CSVs must satisfy the app's own loader (the same one db:seed uses).
    const recs = loadPlayerRecordsFromCsv(dir);
    expect(recs.map((r) => r.player.id)).toEqual(["nikola-jokic", "shai-gilgeous-alexander", "victor-wembanyama", "cooper-flagg", "kawhi-leonard"]);
    expect(recs.map((r) => r.market.rank)).toEqual([1, 2, 3, 4, 5]);
    const [jokic, sga, wemby, , kawhi] = recs;
    expect(jokic.player).toMatchObject({ yahooPlayerKey: "466.p.5352", nbaTeam: "DEN", positions: ["C"], age: 27 });
    expect(jokic.projection.pts).toBeCloseTo(2115 / 70, 1);
    expect(jokic.projection.fgm).toBeCloseTo(800 / 70, 1);
    // existing id + age reused, existing risk blended
    expect(sga.player).toMatchObject({ id: "shai-gilgeous-alexander", age: 28, positions: ["PG", "SG"] });
    expect(sga.risk.majorInjuryHistory).toBe(true);
    expect(sga.risk.restRisk).toBe(0.13);
    expect(sga.risk.injuryHistoryScore).toBeCloseTo((1 - 76 / 82 + 0.2) / 2, 1);
    expect(wemby.player.nbaTeam).toBe("SAS");
    expect(wemby.player.positions).toEqual(["C", "PF"]);
    expect(wemby.risk.availabilityScore).toBe(0.71);
    // injured, "-" ADP -> fallback ADP beyond the max (after max 41.5 -> 43), status mapped
    expect(kawhi.market.yahooAdp).toBeCloseTo(41.5 + 1.5, 6);
    expect(kawhi.risk.currentStatus).toBe("out-for-season");
    expect(kawhi.risk.projectedGames).toBeLessThan(15);
    // games columns agree between projections and injuries (validate.py invariant)
    for (const r of recs) expect(r.projection.games).toBe(r.risk.projectedGames);
    // formats: exact headers
    expect(fs.readFileSync(path.join(dir, "projections.csv"), "utf8").split("\n")[0]).toBe(PROJECTION_COLUMNS.join(","));
    expect(parseCsv(fs.readFileSync(path.join(dir, "yahoo-adp.csv"), "utf8"))[0]).toHaveProperty("adp_std_dev");
  });

  it("uses projected_season when probe finds it usable (per-game scale auto-detected) and strict source flag", async () => {
    const dir = tmpData(false);
    const { get } = fakeGet({ projected: true, collectionStatsFail: true });
    const s = await runImport({ get, dataDir: dir, source: "auto", now: new Date("2026-10-07T12:00:00Z") });
    expect(s.sourceUsed).toBe("projected");
    expect(s.backupDir).toBeNull();
    // fixture serves the same Jokic projected line for every player
    expect(s.dataset.stats.fromProjected).toBe(s.counts.written);
    expect(s.statScales).toContain("projected:per_game");
    const recs = loadPlayerRecordsFromCsv(dir);
    expect(recs[0].projection.pts).toBeCloseTo(29, 1);
    expect(recs[0].projection.minutes).toBeCloseTo(34, 1);
  });

  it("falls back through request shapes: out= form failing, collection stats failing", async () => {
    const dir = tmpData(false);
    const { get, calls } = fakeGet({ outFormFails: true, collectionStatsFail: true });
    const s = await runImport({ get, dataDir: dir, source: "last_season" });
    expect(s.counts.written).toBe(5);
    expect(calls.some((c) => /\/draft_analysis$/.test(c))).toBe(true);
    expect(calls.some((c) => /^player\/466\.p\.\d+\/stats;type=season;season=2025$/.test(c))).toBe(true);
  });

  it("dry run writes nothing", async () => {
    const dir = tmpData(false);
    await runImport({ get: fakeGet().get, dataDir: dir, dryRun: true, source: "last_season" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("probe reports raw stat ids", async () => {
    const { results, game } = await probeProjections(fakeGet({ projected: true }).get, 3);
    expect(game.season).toBe(2026);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ usable: true });
    expect(results[0].rawStats).toHaveProperty("9004003", "11.3/19.8");
    const empty = await probeProjections(fakeGet().get, 3);
    expect(empty.results.every((r) => !r.usable)).toBe(true);
  });
});

describe("buildDataset edge cases", () => {
  it("separates slug collisions and skips players without positions/teams", () => {
    const yp = (over: object) => ({ playerKey: "k", playerId: "1", name: "Same Name", teamAbbr: "BOS", displayPosition: "PG", eligiblePositions: ["PG"], status: null, injuryNote: null, averagePick: 10, averageRound: null, percentDrafted: null, percentOwned: null, hasDraftAnalysis: true, stats: null, statsMeta: null, ...over });
    const line = { gp: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 3, fta: 4, threePm: 3, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2 };
    const mk = (over: object, i: number) => ({ yp: yp(over) as never, orIndex: i, line, lineSource: "last_season" as const, lastGp: 70 });
    const d = buildDataset(
      [mk({ playerId: "1", playerKey: "a" }, 0), mk({ playerId: "2", playerKey: "b", averagePick: 11 }, 1), mk({ playerKey: "c", name: "Util Guy", eligiblePositions: ["Util"], displayPosition: "Util" }, 2), mk({ playerKey: "d", name: "No Team", teamAbbr: null }, 3)],
      { projections: new Map(), injuries: new Map() },
      "2026-10-07T00:00:00Z",
    );
    expect(d.projections.map((p) => p.id)).toEqual(["same-name", "same-name-2"]);
    expect(d.skipped).toHaveLength(2);
    expect(toCsv(["a", "b"], [{ a: 'x,"y"', b: "z" }])).toBe('a,b\n"x,""y""",z\n');
  });
});

describe("rookies / players without stats", () => {
  const yp = (over: object) => ({ playerKey: "k", playerId: "1", name: "P", teamAbbr: "BOS", displayPosition: "PG", eligiblePositions: ["PG"], status: null, injuryNote: null, averagePick: 10, averageRound: null, percentDrafted: null, percentOwned: null, hasDraftAnalysis: true, stats: null, statsMeta: null, ...over });
  const line = (pts: number) => ({ gp: 70, minutes: 30, pts, fgm: pts / 3, fga: pts / 1.5, ftm: 3, fta: 4, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2 });
  const vet = (name: string, adp: number, pts: number, i: number) => ({ yp: yp({ name, playerKey: `v${i}`, playerId: `${i}`, averagePick: adp }) as never, orIndex: i, line: line(pts), lineSource: "last_season" as const, lastGp: 70 });
  const rookie = (name: string, adp: number | null, i = 9) => ({ yp: yp({ name, playerKey: `r${i}`, playerId: `r${i}`, averagePick: adp }) as never, orIndex: i, line: null, lineSource: null, lastGp: null });
  const empty = { projections: new Map(), injuries: new Map() };

  it("adpTemplateLine: median of donors within +-10 ADP, scaled 0.9; widens to nearest 3 when sparse", () => {
    const pool = [10, 12, 14, 40].map((adp, i) => ({ adp, line: line([10, 20, 30, 99][i]) }));
    const t = adpTemplateLine(12, pool)!; // donors: 10, 12, 14 -> median pts 20
    expect(t.pts).toBeCloseTo(18, 6);
    expect(t.minutes).toBeCloseTo(27, 6);
    expect(adpTemplateLine(45, pool)!.pts).toBeCloseTo(0.9 * 30, 6); // nearest 3: 40,14,12 -> median 30
    expect(adpTemplateLine(5, [])).toBeNull();
  });

  it("template rookie with ADP is kept, flagged adp_template, and sorted by ADP", () => {
    const d = buildDataset([vet("A Vet", 38, 18, 0), vet("B Vet", 41, 20, 1), vet("C Vet", 44, 22, 2), vet("Far Vet", 5, 40, 3), rookie("Rookie One", 40)], empty, "2026-10-07T00:00:00Z");
    expect(d.skipped).toEqual([]);
    const r = d.projections.find((p) => p.id === "rookie-one")!;
    expect(Number(r.pts)).toBeCloseTo(18, 1); // median(18,20,22)=20 * 0.9
    expect(d.sources.find((x) => x.player_id === "rookie-one")!.source).toBe("adp_template");
    expect(d.sources.filter((x) => x.source === "last_season")).toHaveLength(4);
    expect(d.stats.fromAdpTemplate).toBe(1);
    expect(d.adp.map((a) => a.player_id)).toEqual(["far-vet", "a-vet", "rookie-one", "b-vet", "c-vet"]);
  });

  it("reuses the existing CSV projection row when the slug matches", () => {
    const row = Object.fromEntries(PROJECTION_COLUMNS.map((c) => [c, ""])) as Record<string, string>;
    Object.assign(row, { id: "cooper-flagg", name: "Cooper Flagg", nba_team: "DAL", positions: "SF/PF", age: "19", games: "66", minutes: "32.0", pts: "18.8", fgm: "7.0", fga: "15.0", ftm: "3.5", fta: "4.5", three_pm: "1.3", reb: "6.5", ast: "4.0", stl: "1.2", blk: "1.0", tov: "2.8" });
    const d = buildDataset([vet("A Vet", 40, 50, 0), rookie("Cooper Flagg", 41.5)], { projections: new Map([["cooper-flagg", row]]), injuries: new Map() }, "2026-10-07T00:00:00Z");
    const r = d.projections.find((p) => p.id === "cooper-flagg")!;
    expect(r.pts).toBe("18.80");
    expect(r.age).toBe("19");
    expect(d.sources.find((x) => x.player_id === "cooper-flagg")!.source).toBe("existing_csv");
    expect(d.stats.fromExistingCsv).toBe(1);
  });

  it("an unusable existing row falls through to the template; no ADP or no donors -> skipped", () => {
    const bad = { id: "cooper-flagg", name: "Cooper Flagg", pts: "x" } as Record<string, string>;
    const d = buildDataset([vet("A Vet", 40, 20, 0), rookie("Cooper Flagg", 41.5, 5), rookie("No Adp", null, 6)], { projections: new Map([["cooper-flagg", bad]]), injuries: new Map() }, "2026-10-07T00:00:00Z");
    expect(d.sources.find((x) => x.player_id === "cooper-flagg")!.source).toBe("adp_template");
    expect(d.skipped.map((k) => k.name)).toEqual(["No Adp"]);
    const none = buildDataset([rookie("Lonely", 20)], empty, "2026-10-07T00:00:00Z");
    expect(none.skipped).toHaveLength(1);
  });
});
