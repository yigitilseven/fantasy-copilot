import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { classifyStandingsView, parseBoard, parseLeagueName, parseStandings } from "../extension/parser.js";

const load = (f: string) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures-extension", f), "utf8")).window.document;

describe("parseStandings (real finished-draft snapshots, three stat views)", () => {
  // The <select>'s selected state is lost in snapshots, so the view is inferred from the number formats.
  it("2026-27 Proj Stats: counting stats print with .0; user rank 2, total 81", () => {
    const r = parseStandings(load("yahoo-standings-proj.html"), { trustSelect: false });
    expect(r.active).toBe(true);
    expect(r.view).toBe("proj-2026-27");
    expect(r.rows).toHaveLength(14);
    expect(r.rows[0]).toMatchObject({ rank: 1, teamName: "Manager AB", fg: 0.474, ft: 0.828, threePm: 1635, pts: 15677, tov: 1853, total: 86.5 });
    expect(r.rows.find((x: { teamName: string }) => x.teamName === "Manager BQ")).toMatchObject({ rank: 2, label: "Your Team", total: 81 });
  });
  it("2025-26 Total Stats: large integers without .0; user rank 8, total 65.5; ties give fractional ranks", () => {
    const r = parseStandings(load("yahoo-standings-total.html"), { trustSelect: false });
    expect(r.view).toBe("total-2025-26");
    expect(r.rows.find((x: { teamName: string }) => x.teamName === "Manager BQ")).toMatchObject({ rank: 8, total: 65.5, pts: 11782, fg: 0.48 });
    expect(r.rows.filter((x: { rank: number }) => x.rank === 10.5)).toHaveLength(2);
  });
  it("2025-26 Average Stats: per-game decimals; user rank 5, total 76.5", () => {
    const r = parseStandings(load("yahoo-standings-avg.html"), { trustSelect: false });
    expect(r.view).toBe("avg-2025-26");
    expect(r.rows.find((x: { teamName: string }) => x.teamName === "Manager BQ")).toMatchObject({ rank: 5, total: 76.5, pts: 210.7, threePm: 21.9 });
  });
  it("classifyStandingsView on raw cells", () => {
    expect(classifyStandingsView([{ threePm: "1635.0", pts: "15677.0", reb: "4861.0", ast: "1.0", stl: "9.0", blk: "5.0", tov: "1853.0" }])).toBe("proj-2026-27");
    expect(classifyStandingsView([{ threePm: "1423", pts: "14156" }])).toBe("total-2025-26");
    expect(classifyStandingsView([{ threePm: "19.5", pts: "228.3" }])).toBe("avg-2025-26");
    expect(classifyStandingsView([])).toBe("unknown");
  });
  it("not on the standings tab -> inactive", () => {
    expect(parseStandings(load("yahoo-board-complete.html")).active).toBe(false);
  });
  it("league name from the header", () => {
    expect(parseLeagueName(load("yahoo-standings-avg.html"))).toBe("Three Seconds - H2H");
  });
});

describe("parseBoard (real finished-draft snapshot)", () => {
  const b = parseBoard(load("yahoo-board-complete.html"));
  it("reads 14 team columns (user header reads 'You') and all 182 picks", () => {
    expect(b.active).toBe(true);
    expect(b.teams).toHaveLength(14);
    expect((b.teams as { name: string }[])[10].name).toBe("•");
    expect(b.teams.find((t: { isUser: boolean }) => t.isUser)).toEqual({ slot: 13, name: "Manager BQ", isUser: true });
    expect(b.picks).toHaveLength(182);
    expect(new Set(b.picks.map((p: { pick: number }) => p.pick)).size).toBe(182);
  });
  it("overall pick numbers follow the snake even though even-round labels count down", () => {
    expect(b.picks[0]).toEqual({ pick: 1, round: 1, teamSlot: 1, teamName: "Manager AB", playerName: "Victor Wembanyama", nbaTeam: "SAS", positions: "C" });
    const p15 = b.picks.find((p: { pick: number }) => p.pick === 15);
    expect(p15).toMatchObject({ teamSlot: 14, round: 2, teamName: "Manager BK" });
    expect(b.picks.find((p: { pick: number }) => p.pick === 28)).toMatchObject({ round: 2, teamSlot: 1, teamName: "Manager AB" });
  });
  it("ground truth of the last three picks (user is slot 13 = pick 181)", () => {
    const last = b.picks.slice(-3).map((p: { pick: number; playerName: string; teamName: string }) => [p.pick, p.playerName, p.teamName]);
    expect(last).toEqual([[180, "Isaiah Stewart", "Manager AK"], [181, "Keldon Johnson", "Manager BQ"], [182, "Jordan Poole", "Manager BK"]]);
  });
  it("every pick sits in the column the snake assigns it (slot of pick n)", () => {
    for (const p of b.picks as { pick: number; round: number; teamSlot: number }[]) {
      const idx = (p.pick - 1) % 14;
      expect(p.teamSlot).toBe(p.round % 2 === 1 ? idx + 1 : 14 - idx);
    }
  });
});
