/* eslint-disable @typescript-eslint/no-explicit-any */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseSeasonMatchup, parseSeasonPlayers, parseSeasonRoster, parseSeasonTransactions, parseTxnDate, parseSeasonUrl } from "../extension/parser.js";

const doc = (html: string) => new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`).window.document;
const NOW = Date.parse("2026-10-22T12:00:00Z");

describe("div-based layouts (no tables)", () => {
  const roster = doc(`
    <div class="roster">
      <div class="row"><span class="slot">PG</span><div class="p"><a href="https://sports.yahoo.com/nba/players/5638">Jamal Murray</a><span class="meta">DEN - PG</span></div><span>@OKC</span></div>
      <div class="row"><span class="slot">BN</span><div class="p"><a href="https://sports.yahoo.com/nba/players/6408">Isaiah Stewart</a><span class="meta">MEM - PF,C</span><span class="tag">O</span></div></div>
      <div class="row"><span class="slot">IL+</span><div class="p"><a href="https://sports.yahoo.com/nba/players/5905">Royce O'Neale</a><span class="meta">CHA - SF,PF</span></div></div>
    </div>`);
  it("finds rows by their player link and reads slot, team/positions and tag", () => {
    const r = parseSeasonRoster(roster).rows as any[];
    expect(r.map((x: { slot: string }) => x.slot)).toEqual(["PG", "BN", "IL+"]);
    expect(r[0]).toMatchObject({ playerName: "Jamal Murray", yahooId: "5638", nbaTeam: "DEN", positions: "PG" });
    expect(r[1]).toMatchObject({ injuryTag: "O", positions: "PF/C" });
  });
  it("a list without slots is a players list", () => {
    const p = parseSeasonPlayers(doc(`<ul><li><a href="/nba/players/7001">Scoot Henderson</a> <span>POR - PG</span> <span>DTD</span></li><li><a href="/nba/players/7002">Dalen Terry</a> <span>CHI - SG,SF</span></li></ul>`)).rows;
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ yahooId: "7001", nbaTeam: "POR", injuryTag: "DTD" });
  });
});

describe("matchup layouts", () => {
  const cats = ["FG%", "FT%", "3PTM", "PTS", "REB", "AST", "ST", "BLK", "TO"];
  const a = [".484", ".844", "20", "171", "59", "29", "7", "1", "16"];
  const b = [".513", ".756", "14", "163", "59", "41", "14", "7", "22"];
  const links = `<a href="/nba/1/9">Team Nine</a> <a href="/nba/1/13">Team Thirteen</a>`;
  it("category rows in a table: value | label | value", () => {
    const m = parseSeasonMatchup(doc(`${links}<table>${cats.map((c, i) => `<tr><td>${a[i]}</td><td>${c}</td><td>${b[i]}</td></tr>`).join("")}</table>`), "1");
    expect(m.found).toBe(true);
    expect(m.teams[0]).toMatchObject({ name: "Team Nine", cats: { fgPct: 0.484, pts: 171, tov: 16, threePm: 20 } });
    expect(m.teams[1].cats).toMatchObject({ fgPct: 0.513, stl: 14 });
  });
  it("category rows made of divs", () => {
    const m = parseSeasonMatchup(doc(`${links}<div>${cats.map((c, i) => `<div class="cat"><span>${a[i]}</span><span>${c}</span><span>${b[i]}</span></div>`).join("")}</div>`), "1");
    expect(m.found).toBe(true);
    expect(m.layout).toBe("label-rows");
    expect(m.teams[1].cats).toMatchObject({ ast: 41, blk: 7 });
  });
  it("category columns (teams as rows) with made/attempted columns and percent values", () => {
    const head = ["Team", "FGM/A*", "FG%", "FTM/A*", "FT%", "3PTM", "PTS", "REB", "AST", "ST", "BLK", "TO"];
    const row = (id: number, name: string, v: string[]) => `<tr><td><a href="/nba/1/${id}">${name}</a></td><td>${v[0]}</td>${v.slice(1).map((x) => `<td>${x}</td>`).join("")}</tr>`;
    const html = `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${row(9, "Nine", ["62/128", "48.4", "27/32", "84.4", "20", "171", "59", "29", "7", "1", "16"])}${row(13, "Thirteen", ["59/115", "51.3", "31/41", "75.6", "14", "163", "59", "41", "14", "7", "22"])}</tbody></table>`;
    const m = parseSeasonMatchup(doc(html), "1");
    expect(m.found).toBe(true);
    expect(m.teams[0].cats).toMatchObject({ fgm: 62, fga: 128, fgPct: 0.484, ftPct: 0.844 });
  });
  it("is not found on an unrelated page", () => {
    expect(parseSeasonMatchup(doc(`<table><tr><td>Hello</td></tr></table>`), "1").found).toBe(false);
  });
});

describe("transactions", () => {
  const html = `<table id="transactions-table"><tbody>
    <tr><td>+</td><td><div>Add <a href="https://sports.yahoo.com/nba/players/6001">Ayo Dosunmu</a> <span>MIN - SG,PG</span> from Free Agents to <a href="/nba/100001/9">Copilot Grizzlies</a></div>
        <div>Drop <a href="https://sports.yahoo.com/nba/players/6002">Some Guy</a> <span>BOS - PG</span> to Waivers</div></td><td>Oct 21, 2026 9:30 pm</td></tr>
    <tr><td>+</td><td><div>Add <a href="https://sports.yahoo.com/nba/players/6003">Jim Added</a> <span>LAL - SF</span> from Waivers to <a href="/nba/100001/13">Manager BG</a></div></td><td>Oct 20</td></tr>
    <tr><td>T</td><td><div>Trade: <a href="/nba/players/6004">Pat Traded</a> <span>DEN - C</span> from <a href="/nba/100001/5">Drafter AE</a> to <a href="/nba/100001/6">Manager AQ</a></div></td><td>10/19/2026</td></tr>
  </tbody></table>`;
  const rows = parseSeasonTransactions(doc(html), NOW).rows;
  it("reads date, type, player ids and the team of every add / drop / trade", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: "2026-10-21", time: "21:30", type: "add/drop" });
    expect(rows[0].actions).toMatchObject([
      { action: "add", yahooId: "6001", name: "Ayo Dosunmu", nbaTeam: "MIN", positions: "SG/PG", teamId: "9", teamName: "Copilot Grizzlies" },
      { action: "drop", yahooId: "6002", teamId: "9" },
    ]);
    expect(rows[1]).toMatchObject({ date: "2026-10-20", type: "claim" });
    expect(rows[2]).toMatchObject({ type: "trade", date: "2026-10-19" });
    expect(rows[2].actions[0]).toMatchObject({ action: "trade", yahooId: "6004", teamId: "6" });
  });
  it("keys are stable and unique per transaction", () => {
    const again = parseSeasonTransactions(doc(html), NOW).rows;
    expect(again.map((r: { key: string }) => r.key)).toEqual(rows.map((r: { key: string }) => r.key));
    expect(new Set(rows.map((r: { key: string }) => r.key)).size).toBe(3);
  });
  it("finds nothing on a page without player links", () => {
    expect(parseSeasonTransactions(doc("<table><tr><td>No transactions yet</td></tr></table>"), NOW).rows).toEqual([]);
  });
  it("dates: year inferred from now, times converted", () => {
    expect(parseTxnDate("Oct 20", NOW)).toEqual({ date: "2026-10-20", time: null });
    expect(parseTxnDate("Dec 30", NOW)).toEqual({ date: "2025-12-30", time: null });
    expect(parseTxnDate("10/21/2026 12:05 am", NOW)).toEqual({ date: "2026-10-21", time: "00:05" });
    expect(parseTxnDate("nothing", NOW)).toBeNull();
  });
  it("url kinds", () => {
    expect(parseSeasonUrl("https://basketball.fantasysports.yahoo.com/nba/100001/transactions").kind).toBe("transactions");
  });
});
