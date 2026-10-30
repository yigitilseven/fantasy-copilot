import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { getAllPlayerRecords } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { averageLines, fetchFantasyProsProjections, fpLine, indexFpRows, loadFantasyProsProjections, parseFantasyProsProjections, FP_PROJECTIONS_CACHE } from "@/integrations/projections/fantasypros-projections";
import { makeRecord } from "./fixtures";

const html = fs.readFileSync(path.join(__dirname, "fixtures-real", "fantasypros-projections.html"), "utf8");

describe("FantasyPros projections parser", () => {
  const rows = parseFantasyProsProjections(html);
  it("parses season totals by header label (thousands separators, percentages, team and positions)", () => {
    expect(rows).toHaveLength(6); // the 7th fixture row has a missing value and is skipped
    expect(rows[0]).toMatchObject({ name: "Shai Gilgeous-Alexander", team: "OKC", gp: 77, min: 2636, pts: 2394, reb: 349, ast: 481, blk: 63, stl: 124, fgPct: 0.528, ftPct: 0.887, threePm: 130, tov: 179 });
    expect(rows[0].positions).toEqual(["PG"]);
    expect(rows[1].positions).toEqual(["PF", "C"]);
  });
  it("returns [] for a page without the table or without the needed columns", () => {
    expect(parseFantasyProsProjections("<html>blocked</html>")).toEqual([]);
    expect(parseFantasyProsProjections(html.replace("<th>REB</th>", "<th>XXX</th>"))).toEqual([]);
  });
  it("tolerates a reordered column layout", () => {
    const re = html.replace("<th>PTS</th><th>REB</th>", "<th>REB</th><th>PTS</th>");
    // columns now swapped in the header only: values are read from the new positions
    expect(parseFantasyProsProjections(re)[0].pts).toBe(349);
  });

  it("fpLine: per game = total / GP, minutes = MIN / GP, attempts derived (points identity), makes / attempts reproduce the percentages", () => {
    const l = fpLine(rows[0]);
    expect(l.games).toBe(77);
    expect(l.pts).toBeCloseTo(2394 / 77);
    expect(l.minutes).toBeCloseTo(2636 / 77);
    expect(l.fgm / l.fga).toBeCloseTo(0.528, 6);
    expect(l.ftm / l.fta).toBeCloseTo(0.887, 6);
    expect(2 * l.fgm + l.threePm + l.ftm).toBeCloseTo(l.pts, 6);
  });
  it("averageLines averages every field, keeps FG% as Σmakes/Σattempts and takes minutes from the line that has them", () => {
    const a = fpLine(rows[0]);
    const b = { ...a, pts: a.pts + 4, fga: a.fga + 2, fgm: a.fgm + 1, minutes: 0 };
    const avg = averageLines(b, a);
    expect(avg.pts).toBeCloseTo(a.pts + 2);
    expect(avg.fga).toBeCloseTo(a.fga + 1);
    expect(avg.fgm / avg.fga).toBeCloseTo((a.fgm + 0.5) / (a.fga + 1));
    expect(avg.minutes).toBeCloseTo(a.minutes);
    expect(averageLines(a, { ...a, minutes: 0 }).minutes).toBeCloseTo(a.minutes);
  });
  it("index: full-name match, namesakes resolved by team, ambiguous -> null", () => {
    const r = parseFantasyProsProjections(html);
    const ix = indexFpRows([...r, { ...r[0], team: "XXX", name: "Same Name" }, { ...r[0], team: "YYY", name: "Same Name" }]);
    expect(ix.find({ playerName: "Shai Gilgeous-Alexander" })!.team).toBe("OKC");
    expect(ix.find({ playerName: "Same Name" })).toBeNull();
    expect(ix.find({ playerName: "Same Name", nbaTeam: "YYY" })!.team).toBe("YYY");
    expect(ix.find({ playerName: "Nobody" })).toBeNull();
  });
});

describe("FantasyPros fetch + cache", () => {
  it("fetches once, caches the page, and serves it offline; a non-table response is rejected and not cached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    // the fixture has only 6 rows: build a page with >= 50 by repeating the row block
    const rowsHtml = html.match(/<tr class="mpb-player[\s\S]*?<\/tr>/)![0];
    const big = html.replace(rowsHtml, rowsHtml.repeat(60));
    let calls = 0;
    const fetchImpl = (async () => (calls++, new Response(big, { status: 200 }))) as unknown as typeof fetch;
    const a = await fetchFantasyProsProjections({ cacheDir: dir, fetchImpl, retries: 1 });
    expect(a.fromCache).toBe(false);
    expect(a.rows.length).toBeGreaterThanOrEqual(60);
    expect(fs.existsSync(path.join(dir, FP_PROJECTIONS_CACHE))).toBe(true);
    const b = await fetchFantasyProsProjections({ cacheDir: dir, fetchImpl, offline: true });
    expect(b.fromCache).toBe(true);
    expect(calls).toBe(1);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    const blocked = (async () => new Response("<html>captcha</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchFantasyProsProjections({ cacheDir: dir2, fetchImpl: blocked, retries: 1 })).rejects.toThrow(/projections table/);
    expect(fs.existsSync(path.join(dir2, FP_PROJECTIONS_CACHE))).toBe(false);
    expect(loadFantasyProsProjections(dir2)).toBeNull();
  });
});

describe("getAllPlayerRecords: FantasyPros as part of the projection side", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-repo-"));
  fs.writeFileSync(path.join(dir, FP_PROJECTIONS_CACHE), html);
  const headers = ["PLAYER_NAME", "TEAM_ABBREVIATION", "AGE", "GP", "MIN", "FGM", "FGA", "FTM", "FTA", "FG3M", "REB", "AST", "TOV", "STL", "BLK", "PTS"];
  fs.writeFileSync(path.join(dir, "nba-stats-2025-26.json"), JSON.stringify({ resultSets: [{ name: "x", headers, rowSet: [["Shai Gilgeous-Alexander", "OKC", 27, 68, 33, 10, 20, 7, 8, 1.5, 4.5, 6.5, 2.5, 1.5, 1, 31]] }] }));
  fs.writeFileSync(path.join(dir, "nba-stats-2024-25.json"), JSON.stringify({ resultSets: [{ name: "x", headers, rowSet: [["Shai Gilgeous-Alexander", "OKC", 26, 70, 34, 10.5, 21, 7.2, 8.2, 1.6, 4.6, 6.4, 2.4, 1.6, 1, 32]] }] }));
  const db = createDb(":memory:");
  seedFromRecords(db, [makeRecord({ id: "sga", name: "Shai Gilgeous-Alexander" }), makeRecord({ id: "other", name: "Somebody Else" })]);

  it("attaches the FantasyPros line, 2024-25 line and evidence; the projection side = FantasyPros when Yahoo is absent", () => {
    const recs = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir, fantasyPros: true });
    const sga = recs.find((r) => r.player.id === "sga")!.projection;
    const c = sga.components!;
    expect(c.yahoo).toBeNull();
    expect(c.fantasyPros).toMatchObject({ games: 77 });
    expect(c.projection).toBe(c.fantasyPros);
    expect(c.actualPrev).toMatchObject({ games: 70, pts: 32 });
    expect(c.evidence).toMatchObject({ team25: "OKC", team26: "OKC", team24: "OKC", age: 27 });
    // the top-level projection keeps its contract (Yahoo when captured, else the stored NBA.com line); the blend reads components.projection
    expect(sga.projectionSource).toBe("nba-stats");
    expect(sga.pts).toBe(15);
    expect(recs.find((r) => r.player.id === "other")!.projection.components!.fantasyPros).toBeNull();
  });
  it("auto blend uses the projection side: a rookie with no real stats gets the FantasyPros line, labelled consensus", async () => {
    const { applyProjectionBlend } = await import("@/engine/projection/blend");
    const recs = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir, fantasyPros: true });
    const rookie = recs.find((r) => r.player.id === "sga")!;
    const noActual = { ...rookie, projection: { ...rookie.projection, components: { ...rookie.projection.components!, actual: null, actualPrev: null } } };
    const out = applyProjectionBlend([noActual], "auto")[0].projection;
    expect(out.projectionSource).toBe("consensus-2026-27");
    expect(out.pts).toBeCloseTo(2394 / 77);
    expect(out.blend).toMatchObject({ reason: "no-actual", effectiveWeight: 1 });
    // the fixed 100% mix is the plain overlay
    expect(applyProjectionBlend([rookie], 1)[0]).toBe(rookie);
  });
  it("the plain overlay (no components) is unchanged by the cache", () => {
    expect(getAllPlayerRecords(db, Date.now(), { statsCacheDir: dir }).find((r) => r.player.id === "sga")!.projection.projectionSource).toBe("nba-stats");
  });
  it("default (no flag) is Yahoo only: FantasyPros is opt-in", () => {
    const recs = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir }); // default: Yahoo only
    expect(recs.find((r) => r.player.id === "sga")!.projection.components!.fantasyPros).toBeNull();
  });
});
