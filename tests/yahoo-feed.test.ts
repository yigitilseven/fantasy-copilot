import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseDraftRoom } from "../extension/parser.js";
import { buildNameIndex, matchPlayer } from "@/integrations/yahoo/dom-ingest";
import { createDb } from "@/db/client";
import { seedFromRecords } from "@/db/seed";
import type { Position } from "@/types";
import { makeRecord } from "./fixtures";

const doc = () => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures-extension", "yahoo-2026-feed.html"), "utf8")).window.document;

describe("Yahoo 2026 draft client feed (calibrated from a real snapshot)", () => {
  it("reads pick number, abbreviated name, team, positions and fantasy team; ignores join messages and the players table", () => {
    const r = parseDraftRoom(doc());
    expect(r.method).toBe("yahoo-feed");
    expect(r.picks).toEqual([
      { pick: 1, playerName: "N. Jokić", yahooId: "5352", nbaTeam: "DEN", positions: "C", teamName: "Drafter AG" },
      { pick: 3, playerName: "L. Dončić", yahooId: "6014", nbaTeam: "LAL", positions: "PG/SG", teamName: "Team 3" },
      { pick: 16, playerName: "K. Towns", yahooId: "5432", nbaTeam: "NYK", positions: "PF/C", teamName: "You" },
    ]);
  });
});

describe("matchPlayer with Yahoo's abbreviated first names (real buildNameIndex)", () => {
  const db = createDb(":memory:");
  const rec = (id: string, name: string, nbaTeam: string, positions: Position[]) => {
    const r = makeRecord({ id, name, positions });
    r.player.nbaTeam = nbaTeam;
    return r;
  };
  seedFromRecords(db, [
    rec("karl-anthony-towns", "Karl-Anthony Towns", "NYK", ["PF", "C"]),
    rec("jalen-johnson", "Jalen Johnson", "ATL", ["SF", "PF"]),
    rec("jaren-jackson-jr", "Jaren Jackson Jr.", "MEM", ["PF", "C"]),
    rec("keldon-johnson", "Keldon Johnson", "SAS", ["SF", "PF"]),
    rec("nikola-jokic", "Nikola Jokic", "DEN", ["C"]),
    rec("james-johnson", "James Johnson", "IND", ["PF"]),
  ]);
  const index = buildNameIndex(db);

  it("maps 'K. Towns' (hyphenated first name)", () => {
    const r = matchPlayer(index, { playerName: "K. Towns", nbaTeam: "NYK" });
    expect(r.ok && r.player.id).toBe("karl-anthony-towns");
  });
  it("maps 'N. Jokić' (accent + initial)", () => {
    const r = matchPlayer(index, { playerName: "N. Jokić", nbaTeam: "DEN" });
    expect(r.ok && r.player.id).toBe("nikola-jokic");
  });
  it("maps 'J. Jackson Jr.' despite the suffix", () => {
    const r = matchPlayer(index, { playerName: "J. Jackson Jr.", nbaTeam: "MEM" });
    expect(r.ok && r.player.id).toBe("jaren-jackson-jr");
  });
  it("disambiguates 'J. Johnson' by NBA team, else reports ambiguity", () => {
    const r = matchPlayer(index, { playerName: "J. Johnson", nbaTeam: "ATL" });
    expect(r.ok && r.player.id).toBe("jalen-johnson");
    expect(matchPlayer(index, { playerName: "J. Johnson" }).ok).toBe(false);
  });
  it("full names still match exactly", () => {
    const r = matchPlayer(index, { playerName: "Keldon Johnson" });
    expect(r.ok && r.player.id).toBe("keldon-johnson");
  });
});
