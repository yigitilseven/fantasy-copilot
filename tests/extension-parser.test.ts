import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { CONFIG, finalizePicks, findMarker, parseDraftRoom, parsePickBlock, parsePicksFromText, parseTeamPos, textLines } from "../extension/parser.js";

const load = (f: string) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures-extension", f), "utf8")).window.document;

describe("extension parser: layer 1 + 2 on HTML fixtures", () => {
  it("classic draft-results table (round headers, player links, fantasy team links)", () => {
    const r = parseDraftRoom(load("classic-table.html"));
    expect(r.method).toBe("selectors");
    expect(r.picks).toEqual([
      { pick: 1, playerName: "Nikola Jokić", nbaTeam: "DEN", positions: "C", teamName: "Team Alpha" },
      { pick: 2, playerName: "Shai Gilgeous-Alexander", nbaTeam: "OKC", positions: "PG,SG", teamName: "Team Beta" },
      { pick: 3, playerName: "Jaren Jackson Jr.", nbaTeam: "MEM", positions: "PF,C", teamName: "Team Gamma" },
      { pick: 4, playerName: "Cam Johnson", nbaTeam: "BKN", positions: "SF,PF", teamName: "Team Gamma" },
    ]);
  });

  it("class-named list with a pick-in-round marker needs the team count; ignores the player pool", () => {
    const doc = load("react-list.html");
    const no = parseDraftRoom(doc);
    expect(no.needsTeams).toBe(true);
    expect(no.picks).toEqual([]);
    const r = parseDraftRoom(doc, { teams: 12 });
    expect(r.needsTeams).toBe(false);
    expect(r.picks.map((p: { pick: number; playerName: string }) => [p.pick, p.playerName])).toEqual([
      [1, "Nikola Jokić"],
      [2, "Luka Dončić"],
      [3, "Anthony Edwards"],
    ]);
    expect(r.picks[2]).toEqual({ pick: 3, playerName: "Anthony Edwards", nbaTeam: "MIN", positions: "SG,SF", teamName: "The Dunkers" });
    expect(r.picks.some((p: { playerName: string }) => /Wembanyama/.test(p.playerName))).toBe(false);
  });

  it("flat feed lines fall through to the text heuristic (no known selectors)", () => {
    const r = parseDraftRoom(load("flat-text.html"));
    expect(r.method).toBe("text");
    expect(r.picks).toEqual([
      { pick: 1, playerName: "Nikola Jokic", nbaTeam: "DEN", positions: "C", teamName: "Team Alpha" },
      { pick: 2, playerName: "Luka Doncic", nbaTeam: "LAL", positions: "PG", teamName: "Hoop Dreams" },
      { pick: 3, playerName: "Anthony Edwards", nbaTeam: "MIN", positions: "SG,SF", teamName: "Team Gamma" },
    ]);
  });

  it("round.pick cells split across elements, injury tags stripped, round-relative -> overall", () => {
    const r = parseDraftRoom(load("split-cells.html"), { teams: 12 });
    expect(r.method).toBe("text");
    expect(r.picks).toEqual([
      { pick: 3, playerName: "Anthony Edwards", nbaTeam: "MIN", positions: "SG,SF", teamName: "The Dunkers" },
      { pick: 4, playerName: "Jalen Brunson", nbaTeam: "NYK", positions: "PG", teamName: "Hoop Dreams" },
      { pick: 13, playerName: "Tyrese Haliburton", nbaTeam: "IND", positions: "PG", teamName: "Hoop Dreams" },
    ]);
  });

  it("an available-players table (rank numbers, Draft buttons, ADP) yields no picks", () => {
    const r = parseDraftRoom(load("pool-only.html"));
    expect(r.picks).toEqual([]);
    expect(r.method).toBe("none");
  });

  it("explicit Rd/Pk and Round/Pick markers in list items", () => {
    const r = parseDraftRoom(load("rounds-teams.html"), { teams: 14 });
    expect(r.picks).toEqual([
      { pick: 17, playerName: "Dereck Lively II", nbaTeam: "DAL", positions: "C", teamName: "Team X" },
      { pick: 14, playerName: "Giannis Antetokounmpo", nbaTeam: "MIL", positions: "PF,C", teamName: "Team Y" },
    ].sort((a, b) => a.pick - b.pick));
  });

  it("does not choke on invalid or absent selectors", () => {
    const r = parseDraftRoom(load("flat-text.html"), { rowSelectors: ["[[bad", ".nope"], regionSelectors: ["[[bad"] });
    expect(r.picks).toHaveLength(3);
  });
});

describe("extension parser: pure text heuristic", () => {
  it("handles the common pick-marker shapes", () => {
    const text = [
      "Draft Results",
      "Rd 1 Pick 1",
      "Nikola Jokic",
      "DEN - C",
      "Team Alpha",
      "1.02 Luka Doncic (LAL - PG) Hoop Dreams",
      "3. Anthony Edwards MIN - SG,SF",
      "Pick 4: Jalen Brunson NYK - PG,SG",
      "5",
      "Tyrese Haliburton",
      "IND - PG",
    ].join("\n");
    const { picks } = parsePicksFromText(text, { ...CONFIG, teams: 12 });
    expect(finalizePicks(picks).map((p: { pick: number; playerName: string }) => [p.pick, p.playerName])).toEqual([
      [1, "Nikola Jokic"],
      [2, "Luka Doncic"],
      [3, "Anthony Edwards"],
      [4, "Jalen Brunson"],
      [5, "Tyrese Haliburton"],
    ]);
  });

  it("rejects bare numbers without TEAM - POS and button/ADP rows", () => {
    const { picks } = parsePicksFromText("1\nNikola Jokic\n2.\nLuka Doncic\n0:45\n14 teams\n3 Anthony Edwards MIN - SG | Draft", CONFIG);
    expect(picks).toEqual([]);
  });

  it("helpers", () => {
    expect(parseTeamPos("Anthony Edwards MIN - SG,SF Team")).toMatchObject({ nbaTeam: "MIN", positions: "SG,SF" });
    expect(parseTeamPos("PHO – PG / SG")).toMatchObject({ nbaTeam: "PHO", positions: "PG,SG" });
    expect(parseTeamPos("Team Name - PG")).toBeNull();
    expect(findMarker("1.03 x")).toMatchObject({ kind: "round", a: 1, b: 3 });
    expect(findMarker("12. x")).toMatchObject({ kind: "overall", a: 12 });
    expect(findMarker("Name MIN - SG")).toBeNull();
    expect(parsePickBlock(["7.", "T.J. McConnell", "IND - PG"], null)).toMatchObject({ pick: 7, playerName: "T.J. McConnell", nbaTeam: "IND" });
    expect(parsePickBlock("Rd 2 Pk 1 Foo Bar BOS - C", null)).toEqual({ error: "needs-teams", round: 2, inRound: 1 });
  });

  it("finalizePicks dedupes by pick, prefers detailed entries, sorts and drops nonsense", () => {
    const out = finalizePicks([
      { pick: 2, playerName: "B B" },
      { pick: 1, playerName: "A A", nbaTeam: "BOS" },
      { pick: 2, playerName: "B B", nbaTeam: "NYK", positions: "PG" },
      { pick: 0, playerName: "Z Z" },
      { pick: 99999, playerName: "Z Z" },
    ]);
    expect(out).toEqual([
      { pick: 1, playerName: "A A", nbaTeam: "BOS" },
      { pick: 2, playerName: "B B", nbaTeam: "NYK", positions: "PG" },
    ]);
  });

  it("textLines skips hidden/overlay nodes", () => {
    const d = new JSDOM(`<div>Visible<span style="display:none">x</span><div data-fdc-ignore>overlay</div><p>Next</p><script>1</script></div>`).window.document;
    expect(textLines(d.body)).toEqual(["Visible", "Next"]);
  });
});
