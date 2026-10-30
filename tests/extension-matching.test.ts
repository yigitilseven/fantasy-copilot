import { describe, expect, it } from "vitest";
import { badgeText, buildBoardIndex, canonTeam, initialKey, matchBoardPlayer, nameTokens } from "../extension/parser.js";

const row = (playerId: string, name: string, nbaTeam: string, extra: Record<string, unknown> = {}) => ({ playerId, name, nbaTeam, state: "WAIT", score: 60, rank: 20, ...extra });

describe("extension parser: board matching (Yahoo 'K. Towns' -> server 'Karl-Anthony Towns')", () => {
  const board = [
    row("kat", "Karl-Anthony Towns", "NYK"),
    row("jalen-j", "Jalen Johnson", "ATL"),
    row("james-j", "James Johnson", "IND"),
    row("jj-jr", "Jaren Jackson Jr.", "MEM"),
    row("luka", "Luka Dončić", "LAL"),
    row("sga", "Shai Gilgeous-Alexander", "OKC"),
    row("nic", "Nicolas Claxton", "BKN"),
    row("wemby", "Victor Wembanyama", "SAS"),
    row("tm", "Trey Murphy III", "NOP"),
  ];
  const idx = buildBoardIndex(board);
  const id = (n: string, t?: string) => (matchBoardPlayer(idx, n, t) as { playerId: string } | null)?.playerId ?? null;

  it("normalizes names", () => {
    expect(nameTokens("Jaren Jackson Jr.")).toEqual(["jaren", "jackson"]);
    expect(nameTokens("Luka Dončić")).toEqual(["luka", "doncic"]);
    expect(nameTokens("Trey Murphy III")).toEqual(["trey", "murphy"]);
    expect(initialKey("Karl-Anthony Towns")).toBe("k|towns");
    expect(initialKey("K. Towns")).toBe("k|towns");
    expect(initialKey("Madonna")).toBe("");
  });
  it("matches abbreviated first names with team", () => {
    expect(id("K. Towns", "NYK")).toBe("kat");
    expect(id("K. Towns")).toBe("kat");
    expect(id("S. Gilgeous-Alexander", "OKC")).toBe("sga");
  });
  it("disambiguates J. Johnson by team; ambiguous without a usable team", () => {
    expect(id("J. Johnson", "ATL")).toBe("jalen-j");
    expect(id("J. Johnson", "IND")).toBe("james-j");
    expect(id("J. Johnson")).toBeNull();
    expect(id("J. Johnson", "BOS")).toBeNull();
  });
  it("handles accents and suffixes on either side", () => {
    expect(id("L. Dončić", "LAL")).toBe("luka");
    expect(id("L. Doncic", "LAL")).toBe("luka");
    expect(id("J. Jackson Jr.", "MEM")).toBe("jj-jr");
    expect(id("J. Jackson", "MEM")).toBe("jj-jr");
    expect(id("T. Murphy III", "NOP")).toBe("tm");
  });
  it("maps Yahoo's variant first names via initial and unknown players to null", () => {
    expect(id("N. Claxton", "BKN")).toBe("nic");
    expect(id("V. Wembanyama", "SAS")).toBe("wemby");
    expect(id("Z. Nobody", "BOS")).toBeNull();
  });
  it("folds team aliases", () => {
    for (const [a, b] of [["GS", "GSW"], ["NO", "NOP"], ["NY", "NYK"], ["SA", "SAS"], ["PHO", "PHX"], ["UTAH", "UTA"], ["WSH", "WAS"], ["BRK", "BKN"], ["CHO", "CHA"]]) expect(canonTeam(a)).toBe(b);
    const b2 = buildBoardIndex([row("a", "Jalen Green", "PHX"), row("b", "Jaylen Green", "HOU")]);
    expect((matchBoardPlayer(b2, "J. Green", "PHO") as { playerId: string }).playerId).toBe("a");
  });
  it("badge text: rank prefix only for the top 10", () => {
    expect(badgeText({ state: "DRAFT", score: 74.2, rank: 1 })).toBe("#1 DRAFT 74");
    expect(badgeText({ state: "WAIT", score: 66, rank: 3 })).toBe("#3 WAIT 66");
    expect(badgeText({ state: "AVOID", score: 4.26, rank: 80 })).toBe("AVOID 4.3");
  });
});
