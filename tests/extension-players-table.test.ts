import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { detectStatView, parseDraftRoom, parsePlayersTable, parseResultsTab, parseStatNumber, parseYahooFeed } from "../extension/parser.js";

const html = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures-extension", f), "utf8");
const load = (f: string) => new JSDOM(html(f)).window.document;
const select = (doc: Document) => doc.querySelector("#stat-mode-filter") as HTMLSelectElement;

describe("parsePlayersTable (real Yahoo snapshot fragment, 2026-27 Proj view)", () => {
  const doc = load("yahoo-players-proj.html");
  const r = parsePlayersTable(doc);

  it("maps columns by header text and detects the projected view", () => {
    expect(r.statView).toBe("proj-2026-27");
    expect(r.columns).toEqual(["Player", "XRank", "Rank", "ADP", "GP", "FG%", "FT%", "3PTM", "PTS", "REB", "AST", "ST", "BLK", "TO"]);
    expect(r.rows).toHaveLength(12);
  });

  it("reads a full row incl. the injury tag, '-' ADP and leading-dot percentages", () => {
    expect(r.rows[0]).toEqual({
      yahooId: "10097", playerName: "D. Lively II", nbaTeam: "DAL", positions: "C", injuryTag: "Q",
      xrank: 183, rank: 216, gp: 50, fgPct: 0.714, ftPct: 0.609, threePm: 0, pts: 430, reb: 369, ast: 96, stl: 32, blk: 80, tov: 58,
    });
    expect(r.rows[0]).not.toHaveProperty("adp");
    expect(r.rows[1]).toMatchObject({ yahooId: "10316", playerName: "D. Jenkins", positions: "PG/SG", nbaTeam: "DET", pts: 648 });
    expect(r.rows[1]).not.toHaveProperty("injuryTag");
    expect(r.rows[2]).toMatchObject({ yahooId: "10440", playerName: "J. Fears", adp: 119.6, pts: 1125 });
  });

  it("is not thrown off by the column order: values are looked up by header", () => {
    const d = load("yahoo-players-proj.html");
    // swap the PTS and REB columns (header + every cell)
    const swap = (tr: Element) => {
      const c = tr.children;
      c[8].before(c[9]);
    };
    d.querySelectorAll("tr").forEach(swap);
    const s = parsePlayersTable(d);
    expect(s.columns.slice(8, 10)).toEqual(["REB", "PTS"]);
    expect(s.rows[0]).toMatchObject({ pts: 430, reb: 369 });
  });

  it("every parsed row has a yahoo id, numeric GP and all nine category inputs", () => {
    for (const row of r.rows) {
      expect(row.yahooId).toMatch(/^\d+$/);
      for (const k of ["gp", "fgPct", "ftPct", "threePm", "pts", "reb", "ast", "stl", "blk", "tov"]) expect(typeof (row as Record<string, unknown>)[k]).toBe("number");
    }
  });
});

describe("stat view detection", () => {
  it("follows the selected <option> (text or value)", () => {
    const doc = load("yahoo-players-proj.html");
    const sel = select(doc);
    const cases: [string, string][] = [["projected", "proj-2026-27"], ["average", "avg-2025-26"], ["season", "total-2025-26"], ["advancedstats", "advanced"]];
    for (const [value, view] of cases) {
      sel.value = value;
      expect(detectStatView(doc)).toBe(view);
      expect(parsePlayersTable(doc).statView).toBe(view);
    }
  });

  it("falls back to the projected header ids without a select, else unknown", () => {
    const doc = load("yahoo-players-proj.html");
    doc.querySelector("#filters")!.remove();
    expect(detectStatView(doc)).toBe("proj-2026-27");
    doc.querySelectorAll("th").forEach((th) => th.setAttribute("data-id", "x"));
    expect(detectStatView(doc)).toBe("unknown");
  });

  it("a projection of another season is not 'proj-2026-27'", () => {
    const doc = load("yahoo-players-proj.html");
    const o = select(doc).options[0];
    o.textContent = "2027-28 Proj Stats";
    expect(detectStatView(doc)).toBe("unknown");
  });
});

describe("parseStatNumber", () => {
  it("handles dashes, commas and leading dots", () => {
    expect(parseStatNumber("-")).toBeUndefined();
    expect(parseStatNumber("")).toBeUndefined();
    expect(parseStatNumber("1,125")).toBe(1125);
    expect(parseStatNumber(".714")).toBe(0.714);
    expect(parseStatNumber("119.6")).toBe(119.6);
  });
});

describe("feed rows vs table rows", () => {
  const doc = load("yahoo-players-with-feed.html");
  it("excludes picks-feed rows from the table result, and the feed parser still sees only the feed (now with yahoo ids)", () => {
    const t = parsePlayersTable(doc);
    expect(t.rows).toHaveLength(8);
    const feed = parseYahooFeed(doc);
    expect(feed).toHaveLength(3);
    expect(feed[0]).toMatchObject({ pick: 1, playerName: "N. Jokić", yahooId: "5352" });
    expect((t.rows as { yahooId: string }[]).map((x) => x.yahooId)).not.toContain("5352");
    expect((parseDraftRoom(doc).picks as { yahooId?: string }[]).map((p) => p.yahooId)).toEqual(["5352", "10094", expect.any(String)]);
  });
});

describe("Results tab (best effort, unverified layout)", () => {
  const tabs = (selected: string) => `<ul role="tablist"><li role="presentation"><button role="tab" data-id="players" aria-selected="${selected === "players"}">Players</button></li><li role="presentation"><button role="tab" data-id="results" aria-selected="${selected === "results"}">Results</button></li></ul>`;
  const row = (n: number, id: number, name: string, team: string, pos: string, fteam: string) =>
    `<tr><td>${n}</td><td><div class="ys-player" data-id="${id}"><span>${name}</span><ul><li><abbr><span>${pos}</span></abbr></li><li><abbr><span>${team}</span></abbr></li></ul></div></td><td>${fteam}</td></tr>`;
  const page = (selected: string) =>
    new JSDOM(`<body>${tabs(selected)}<table><tbody>${row(1, 5352, "N. Jokić", "DEN", "C", "Team A")}${row(2, 10094, "V. Wembanyama", "SAS", "C", "Team B")}</tbody></table></body>`).window.document;

  it("reads pick, player, team and yahoo id when the Results tab is selected", () => {
    const r = parseResultsTab(page("results"));
    expect(r.active).toBe(true);
    expect(r.picks).toEqual([
      { pick: 1, playerName: "N. Jokić", yahooId: "5352", nbaTeam: "DEN", positions: "C", teamName: "Team A" },
      { pick: 2, playerName: "V. Wembanyama", yahooId: "10094", nbaTeam: "SAS", positions: "C", teamName: "Team B" },
    ]);
  });

  it("does nothing while another tab is selected", () => {
    expect(parseResultsTab(page("players"))).toEqual({ active: false, picks: [] });
  });
});

import { mergePickLists, panelState, parseHeaderState, parseResultsTeams, pickAlert } from "../extension/parser.js";

describe("header fallback + panel state (real snapshots)", () => {
  it("Queue tab at the last pick: header gives pick 181 = O. Ighodaro, feed is hidden", () => {
    const doc = load("yahoo-header-queue-tab.html");
    expect(parseHeaderState(doc)).toEqual({ active: true, complete: false, currentPick: 182, last: { pick: 181, playerName: "O. Ighodaro", positions: "C", nbaTeam: "PHX", via: "header" } });
    expect(panelState(doc)).toBe("hidden");
    expect(parseDraftRoom(doc).picks).toEqual([]);
  });

  it("Picks tab (10-07, Round 2 Pick 18): overall numbering, 17 picks made; feed visible", () => {
    const doc = load("yahoo-header-picks-tab.html");
    const h = parseHeaderState(doc);
    expect(h.currentPick).toBe(18);
    expect(h.last).toEqual({ pick: 17, playerName: "S. Barnes", positions: "SF/PF/C", nbaTeam: "TOR", via: "header" });
  });

  it("no pick on the clock (draft complete) -> inactive, panel n/a", () => {
    const doc = new JSDOM("<body><div>10:52 Draft Complete</div></body>").window.document;
    expect(parseHeaderState(doc)).toEqual({ active: false, complete: true, currentPick: null, last: null });
    expect(panelState(doc)).toBe("n/a");
  });

  it("Draft Complete with a stale 'Round 13, Pick 182' + 'Last: J. Poole' derives NO header pick (the draft-7 corruption)", () => {
    const doc = new JSDOM("<body><div>00:00 Drafter ZZ's Pick \u2022 Round 13, Pick 182</div><div>Last: J. Poole (SG \u00b7 MEM)</div><div>Draft Complete</div></body>").window.document;
    expect(parseHeaderState(doc).last).toBeNull();
    expect(parseHeaderState(doc).complete).toBe(true);
  });

  it("header picks keep via:'header' through mergePickLists; feed picks replace them", () => {
    const m = mergePickLists([{ pick: 5, playerName: "A. Old", via: "header" }, { pick: 6, playerName: "B. One", via: "header" }], [{ pick: 5, playerName: "A. New" }]);
    expect(m).toEqual([{ pick: 5, playerName: "A. New" }, { pick: 6, playerName: "B. One", via: "header" }]);
  });

  it("mergePickLists: later lists win", () => {
    const m = mergePickLists([{ pick: 5, playerName: "A. Old" }, { pick: 6, playerName: "B. One" }], [{ pick: 5, playerName: "A. New", yahooId: "9" }]);
    expect(m).toEqual([{ pick: 5, playerName: "A. New", yahooId: "9" }, { pick: 6, playerName: "B. One" }]);
  });
});

describe("pickAlert condition", () => {
  const base = { panel: "hidden" as const, pageVisible: true, hiddenSince: 1000, now: 1000, graceMs: 3000 };
  it("needs the panel missing for more than the grace period", () => {
    expect(pickAlert({ ...base, now: 3500 }).show).toBe(false);
    expect(pickAlert({ ...base, now: 4500 })).toEqual({ show: true, reason: "panel-hidden" });
  });
  it("clears as soon as the feed is back; a hidden page alerts at once; not live = no alert", () => {
    expect(pickAlert({ ...base, now: 9000, panel: "picks", hiddenSince: null }).show).toBe(false);
    expect(pickAlert({ ...base, now: 1000, pageVisible: false })).toEqual({ show: true, reason: "page-hidden" });
    expect(pickAlert({ ...base, now: 9000, panel: "n/a", hiddenSince: null }).show).toBe(false);
  });
});

describe("Results > Teams (real snapshot of the finished draft)", () => {
  const r = parseResultsTeams(load("yahoo-results-teams.html"));
  it("reads one team's picks with overall pick numbers and yahoo ids", () => {
    expect(r.active).toBe(true);
    expect(r.teamName).toBe("Drafter AK");
    expect(r.picks).toHaveLength(13);
    expect(r.picks.slice(0, 2)).toEqual([
      { pick: 1, playerName: "N. Jokić", yahooId: expect.any(String), nbaTeam: "DEN", positions: "C", teamName: "Drafter AK" },
      { pick: 28, playerName: "L. Ball", yahooId: "6395", nbaTeam: "MIN", positions: "PG", teamName: "Drafter AK" },
    ]);
    expect((r.picks as { pick: number }[]).map((p) => p.pick)).toContain(140);
    expect(parseDraftRoom(load("yahoo-results-teams.html")).method).toBe("results-teams");
  });
});
