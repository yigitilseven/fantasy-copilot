import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { createDraft, getAllPlayerRecords, recordPick } from "@/db/repository";
import { yahooProjections } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { blendLines } from "@/engine/projection/blend";
import { computeEvaluation, computeOutlook } from "@/server/evaluation";
import type { ProjectionLine } from "@/types";
import { makeRecord } from "./fixtures";

const line = (o: Partial<ProjectionLine> = {}): ProjectionLine => ({
  games: 70, minutes: 30, pts: 20, fgm: 7, fga: 15, ftm: 4, fta: 5, threePm: 2, reb: 5, ast: 4, stl: 1, blk: 0.5, tov: 2, ...o,
});

describe("reliability: no projection and a tiny real sample", () => {
  it("blendLines gives no line (a namesake's handful of games must not become a player's projection)", () => {
    expect(blendLines(null, line({ games: 6 }), 0.6)).toBeNull();
    expect(blendLines(null, line({ games: 30 }), 0.6)!.info.reason).toBe("no-yahoo");
  });
});

describe("DB: evidence, placeholders and the auto evaluation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blend-int-"));
  const headers = ["PLAYER_NAME", "TEAM_ABBREVIATION", "AGE", "GP", "MIN", "FGM", "FGA", "FTM", "FTA", "FG3M", "REB", "AST", "TOV", "STL", "BLK", "PTS"];
  const rs = (rowSet: unknown[][]) => JSON.stringify({ resultSets: [{ name: "x", headers, rowSet }] });
  fs.writeFileSync(path.join(dir, "nba-stats-2025-26.json"), rs([
    ["Stable Vet", "AAA", 28, 70, 33, 7, 15, 4, 5, 2, 6, 5, 2, 1, 0.5, 20],
    ["Real Butler", "GSW", 36, 55, 30, 6, 12, 5, 6, 1, 5, 5, 1.5, 1.5, 0.3, 17],
  ]));
  fs.writeFileSync(path.join(dir, "nba-stats-2024-25.json"), rs([["Stable Vet", "AAA", 27, 72, 33, 7, 15, 4, 5, 2, 6, 5, 2, 1, 0.5, 20]]));
  fs.writeFileSync(path.join(dir, "nba-playerindex-2025-26.json"), JSON.stringify({ resultSets: [{ name: "PlayerIndex", headers: ["PLAYER_LAST_NAME", "PLAYER_FIRST_NAME", "POSITION", "DRAFT_YEAR", "FROM_YEAR"], rowSet: [["Vet", "Stable", "F", 2018, 2018]] }] }));
  const yrow = (id: string, name: string, team: string) => ({
    yahooId: `y-${id}`, playerId: id, name, nbaTeam: team, positions: "SF", gp: 70, fgPct: 0.47, ftPct: 0.8, threePm: 140, pts: 1400, reb: 420, ast: 350, stl: 70, blk: 35, tov: 140,
    xrank: 1, rank: 1, adp: 20, season: "2026-27", capturedAt: "2026-10-09T00:00:00Z",
  });
  const db = createDb(":memory:");
  let draftId = 0;
  beforeAll(() => {
    seedFromRecords(db, [
      makeRecord({ id: "vet", name: "Stable Vet", age: 28, projection: { pts: 20 } }),
      makeRecord({ id: "yahoo-j-butler-mil", name: "J. Butler Jr.", projection: { pts: 0, games: 0 } }),
      makeRecord({ id: "p3", name: "Nobody 3" }),
      makeRecord({ id: "p4", name: "Nobody 4" }),
    ]);
    db.insert(yahooProjections).values([yrow("vet", "Stable Vet", "AAA"), yrow("p3", "Nobody 3", "AAA")]).run();
    draftId = createDraft(db, { teams: 2, userSlot: 1, rounds: 2 }).id;
    for (const id of ["vet", "p3", "p4", "yahoo-j-butler-mil"]) recordPick(db, draftId, id);
  });

  it("components carry the 2024-25 line, the teams, the age (+1) and the first season", () => {
    const vet = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir }).find((r) => r.player.id === "vet")!.projection.components!;
    expect(vet.actualPrev).toMatchObject({ games: 72, minutes: 33 });
    expect(vet.evidence).toEqual({ age: 29, team26: "AAA", team25: "AAA", team24: "AAA", fromYear: 2018 });
  });

  it("a Yahoo-created placeholder is not matched to a namesake on another team (initial + last name)", () => {
    const ph = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir }).find((r) => r.player.id === "yahoo-j-butler-mil")!;
    expect(ph.projection.components!.actual).toBeNull();
  });

  it("evaluation 'auto' view and the outlook (auto row + mode)", () => {
    const recs = getAllPlayerRecords(db, Date.now(), { withComponents: true, statsCacheDir: dir });
    const auto = computeEvaluation(db, draftId, { view: "auto", records: recs })!;
    expect(auto.view).toBe("auto");
    expect(auto.standings).toHaveLength(2);
    const o = computeOutlook(db, draftId, { records: recs, mode: "auto" })!;
    expect(o.mode).toBe("auto");
    expect(o.views.auto).not.toBeNull();
    expect(o.sweep).toHaveLength(6);
    // what-if roster override replaces only the user's team
    const whatIf = computeEvaluation(db, draftId, { view: "proj", records: recs, userRoster: ["p4"] })!;
    expect(whatIf.standings.find((s) => s.id === 1)!.rosterSize).toBe(1);
    expect(whatIf.standings.find((s) => s.id === 2)!.rosterSize).toBe(2);
  });
});
