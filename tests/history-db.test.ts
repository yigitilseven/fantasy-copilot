import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import {
  activeOpponentModel, classifyDraftKind, ensureDraftMeta, listDraftSummaries, loadAnalysisDraft, loadStandings, loadStoredModel, recordStandings, saveOpponentModel, setOpponentModelEnabled,
} from "@/db/history";
import { createDraft, getDraft, recordPick } from "@/db/repository";
import { draftPickContext, draftTeam } from "@/db/schema";
import { seedFromRecords } from "@/db/seed";
import { ingestDomPicks } from "@/integrations/yahoo/dom-ingest";
import { applyPostdraft } from "@/integrations/yahoo/postdraft";
import { importSnapshots } from "@/integrations/yahoo/snapshot-import";
import { makeRecord } from "./fixtures";

const names = ["Alpha One", "Bravo Two", "Charlie Three", "Delta Four", "Echo Five", "Foxtrot Six", "Golf Seven", "Hotel Eight"];
const RECORDS = names.map((n, i) => makeRecord({ id: n.split(" ")[0].toLowerCase(), name: n, market: { rank: i + 1, yahooAdp: i + 1 } }));

let db: Db;
let id: number;
beforeEach(() => {
  db = createDb(":memory:");
  seedFromRecords(db, RECORDS);
  id = createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id;
});

const feed = (n: number, withTeam = true) =>
  names.slice(0, n).map((playerName, i) => ({ pick: i + 1, playerName, ...(withTeam ? { teamName: ["Al", "Me", "Cy", "Di"][[0, 1, 2, 3, 3, 2, 1, 0][i]] } : {}), yahooId: String(100 + i) }));

describe("draft kind", () => {
  it("yahoo-dom picks -> yahoo-live; simulation -> mock-bots; manual; unknown placeholders -> damaged", () => {
    ingestDomPicks({ db, draftId: id, picks: feed(4) });
    expect(classifyDraftKind(db, id)).toBe("yahoo-live");
    const bots = createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id;
    recordPick(db, bots, "alpha", "simulation");
    expect(classifyDraftKind(db, bots)).toBe("mock-bots");
    const man = createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id;
    recordPick(db, man, "alpha", "manual");
    expect(classifyDraftKind(db, man)).toBe("manual");
    expect(classifyDraftKind(db, createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id)).toBe("manual");
    // 1 of 8 picks held by an unknown placeholder (> 10%) -> damaged
    const bad = createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id;
    ingestDomPicks({ db, draftId: bad, picks: feed(8, false).filter((p) => p.pick !== 4) });
    expect(classifyDraftKind(db, bad)).toBe("damaged");
    expect(listDraftSummaries(db).find((s) => s.id === bad)!.kind).toBe("damaged");
  });
});

describe("ingest records history", () => {
  it("writes team names by snake slot, per-pick context (ADP, yahoo id) and meta", () => {
    ingestDomPicks({ db, draftId: id, picks: feed(6), history: { roomKey: "123/4", leagueName: "My League" } });
    const teams = db.select().from(draftTeam).all();
    expect(teams.map((t) => [t.teamSlot, t.yahooTeamName]).sort()).toEqual([[1, "Al"], [2, "Me"], [3, "Cy"], [4, "Di"]]);
    const ctx = db.select().from(draftPickContext).all().sort((a, b) => a.pick - b.pick);
    expect(ctx).toHaveLength(6);
    expect(ctx[2]).toMatchObject({ pick: 3, adpAtPick: 3, yahooId: "102", teamName: "Cy", ourRankAtPick: null });
    expect(listDraftSummaries(db).find((s) => s.id === id)).toMatchObject({ kind: "yahoo-live", leagueName: "My League", picks: 6 });
    // idempotent
    ingestDomPicks({ db, draftId: id, picks: feed(6) });
    expect(db.select().from(draftPickContext).all()).toHaveLength(6);
  });
  it("records cached recommendation rank/state when the peek has them", () => {
    ingestDomPicks({ db, draftId: id, picks: feed(2), history: { peek: (_d, pick) => (pick === 2 ? { rank: 3, state: "TAKE", available: 7 } : null) } });
    const c = db.select().from(draftPickContext).all().find((r) => r.pick === 2)!;
    expect(c).toMatchObject({ ourRankAtPick: 3, ourStateAtPick: "TAKE", availableCount: 7 });
    expect(loadAnalysisDraft(db, id)!.teamNames[2]).toBe("Me");
  });
  it("never fails or blocks ingestion, even when the history tables are gone or the peek throws", () => {
    db.run(sql`DROP TABLE draft_pick_context`);
    db.run(sql`DROP TABLE draft_team`);
    const r = ingestDomPicks({ db, draftId: id, picks: feed(3) });
    expect(r.ingested).toBe(3);
    expect(getDraft(db, id)!.picks).toHaveLength(3);
    const id2 = createDraft(db, { teams: 4, userSlot: 2, rounds: 2 }).id;
    const r2 = ingestDomPicks({ db, draftId: id2, picks: feed(2), history: { peek: () => { throw new Error("boom"); } } });
    expect(r2.ingested).toBe(2);
  });
  it("a rewind drops the stale context of the replaced picks", () => {
    ingestDomPicks({ db, draftId: id, picks: feed(4) });
    const swapped = feed(4);
    [swapped[2].playerName, swapped[3].playerName] = [swapped[3].playerName, swapped[2].playerName];
    const r = ingestDomPicks({ db, draftId: id, picks: swapped });
    expect(r.corrected?.fromPick).toBe(3);
    const c3 = db.select().from(draftPickContext).all().find((x) => x.pick === 3)!;
    expect(c3.adpAtPick).toBe(4); // Delta Four (ADP 4) is now at pick 3
  });
});

describe("standings + model params + postdraft", () => {
  it("stores standings per view (replaced on re-capture) and the user's rank shows in the summary", () => {
    ingestDomPicks({ db, draftId: id, picks: feed(2) });
    recordStandings(db, id, "proj-2026-27", [{ rank: 1, teamName: "Al", total: 9 }, { rank: 2, teamName: "Me", total: 8.5 }]);
    recordStandings(db, id, "proj-2026-27", [{ rank: 2, teamName: "Al", total: 8 }, { rank: 1, teamName: "Me", total: 9 }]);
    expect(loadStandings(db, id)).toHaveLength(2);
    ensureDraftMeta(db, id);
    db.update(draftTeam).set({ isUser: true }).where(sql`team_slot = 2`).run();
    expect(listDraftSummaries(db).find((s) => s.id === id)!.ranks["proj-2026-27"]).toEqual({ rank: 1, total: 9 });
  });
  it("fitted model is stored disabled; only an enabled fit reaches the simulator", () => {
    expect(activeOpponentModel(db)).toBeUndefined();
    saveOpponentModel(db, { k: 2.2, autopickShare: 0.1 }, { n: 5 });
    expect(loadStoredModel(db)).toMatchObject({ k: 2.2, autopickShare: 0.1, enabled: false });
    expect(activeOpponentModel(db)).toBeUndefined();
    expect(setOpponentModelEnabled(db, true)).toBe(true);
    expect(activeOpponentModel(db)).toEqual({ k: 2.2, autopickShare: 0.1 });
    saveOpponentModel(db, { k: 1.7, autopickShare: 0 }); // refit keeps the toggle
    expect(activeOpponentModel(db)).toEqual({ k: 1.7, autopickShare: 0 });
  });
  it("postdraft: the Board fills a missing last pick and a wrongly placed one is repaired (draft-7 sequence)", () => {
    // live feed ends one short and the last pick sits where the user's belongs (header corruption)
    ingestDomPicks({ db, draftId: id, picks: feed(7) });
    const board = {
      teams: [{ slot: 1, name: "Al" }, { slot: 2, name: "Me", isUser: true }, { slot: 3, name: "Cy" }, { slot: 4, name: "Di" }],
      picks: feed(8, false).map((p, i) => ({ pick: p.pick, playerName: p.playerName, teamName: ["Al", "Me", "Cy", "Di"][[0, 1, 2, 3, 3, 2, 1, 0][i]] })),
    };
    const r = applyPostdraft(db, id, { board, standings: [{ view: "total-2025-26", rows: [{ rank: 1, teamName: "Me", total: 70 }, { rank: 2, teamName: "Al", total: 60 }] }, { view: "bogus", rows: [{ rank: 1, teamName: "x" }, { rank: 2, teamName: "y" }] }], roomKey: "9/9", leagueName: "L" });
    expect(r.draftComplete).toBe(true);
    expect(r.standingsViews).toEqual(["total-2025-26"]);
    const d = getDraft(db, id)!;
    expect(d.picks).toHaveLength(8);
    expect(d.picks[7]).toMatchObject({ pick: 8, playerId: "hotel", teamSlot: 1, source: "yahoo-dom" });
    expect(db.select().from(draftTeam).all().find((t) => t.isUser)!.yahooTeamName).toBe("Me");
    expect(listDraftSummaries(db).find((s) => s.id === id)).toMatchObject({ userTeam: "Me", kind: "yahoo-live", ranks: { "total-2025-26": { rank: 1, total: 70 } } });
    // idempotent
    expect(applyPostdraft(db, id, { board }).boardIngest!.ingested).toBe(0);
  });
});

describe("snapshot importer (real draft-7 fragments)", () => {
  it("imports standings in the three views, teams and the full board from draftroom-*.html files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snaps-"));
    const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures-extension", f), "utf8");
    const url = "<!-- url: https://basketball.fantasysports.yahoo.com/draftclient/nba/2675311/13?auth= -->\n";
    fs.writeFileSync(path.join(dir, "draftroom-2026-10-09T13-46-50-938Z.html"), url + fx("yahoo-board-complete.html"));
    fs.writeFileSync(path.join(dir, "draftroom-2026-10-09T13-47-27-635Z.html"), url + fx("yahoo-standings-total.html"));
    fs.writeFileSync(path.join(dir, "draftroom-2026-10-09T13-47-30-803Z.html"), url + fx("yahoo-standings-avg.html"));
    fs.writeFileSync(path.join(dir, "draftroom-2026-10-09T13-47-34-303Z.html"), url + fx("yahoo-standings-proj.html"));
    fs.writeFileSync(path.join(dir, "draftroom-2026-10-09T13-40-00-000Z.html"), "<!-- url: https://basketball.fantasysports.yahoo.com/draftclient/nba/999/1 -->\n<html></html>");
    const big = createDb(":memory:");
    // a league of 14 teams x 13 rounds whose players are the board's names (so name matching is exercised for real)
    const did = createDraft(big, { teams: 14, userSlot: 13, rounds: 13 }).id;
    const rep = importSnapshots(big, did, { dir, room: "2675311/13" });
    expect(rep).toMatchObject({ room: "2675311/13", files: 4, boardPicks: 182, teams: 14 });
    expect(rep.views.sort()).toEqual(["avg-2025-26", "proj-2026-27", "total-2025-26"]);
    const st = loadStandings(big, did);
    expect(st).toHaveLength(42);
    const me = st.filter((s) => s.teamName === "Manager BQ").map((s) => [s.view, s.rank, s.total]).sort();
    expect(me).toEqual([["avg-2025-26", 5, 76.5], ["proj-2026-27", 2, 81], ["total-2025-26", 8, 65.5]]);
    expect(big.select().from(draftTeam).all().find((t) => t.isUser)).toMatchObject({ teamSlot: 13, yahooTeamName: "Manager BQ" });
    // unknown players come in as placeholders through the normal path, source yahoo-dom, all 182 picks, draft complete
    const d = getDraft(big, did)!;
    expect(d.picks).toHaveLength(182);
    expect(d.status).toBe("complete");
    expect(d.picks.every((p) => p.source === "yahoo-dom")).toBe(true);
    expect(listDraftSummaries(big).find((s) => s.id === did)).toMatchObject({ leagueName: "Three Seconds - H2H", userTeam: "Manager BQ" });
  });
});
