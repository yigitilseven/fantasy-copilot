import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { createDraft, getDraft, recordPick } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { buildNameIndex, canonTeam, ingestDomPicks, matchPlayer } from "@/integrations/yahoo/dom-ingest";
import type { PlayerRecord } from "@/types";
import { makeRecord } from "./fixtures";

function rec(id: string, name: string, nbaTeam: string, positions: PlayerRecord["player"]["positions"], rank: number): PlayerRecord {
  const r = makeRecord({ id, name, positions, market: { rank } });
  r.player.nbaTeam = nbaTeam;
  return r;
}

const RECORDS = [
  rec("jokic", "Nikola Jokic", "DEN", ["C"], 1),
  rec("sga", "Shai Gilgeous-Alexander", "OKC", ["PG", "SG"], 2),
  rec("jjj", "Jaren Jackson Jr.", "MEM", ["PF", "C"], 3),
  rec("claxton", "Nic Claxton", "BKN", ["C"], 4),
  rec("luka", "Luka Doncic", "LAL", ["PG"], 5),
  rec("jw-okc", "Jalen Williams", "OKC", ["SG", "SF"], 6),
  rec("jw-pho", "Jalen Williams", "PHX", ["PG"], 7),
  rec("kd-1", "Kevin Durant", "HOU", ["SF", "PF"], 8),
  rec("amen", "Amen Thompson", "HOU", ["SG", "SF"], 9),
  rec("ausar", "Ausar Thompson", "DET", ["SF"], 10),
];

describe("dom-ingest", () => {
  let db: Db;
  let id: number;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, RECORDS);
    id = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
  });
  const names = (d = getDraft(db, id)!) => d.picks.map((p) => p.playerId);

  it("ingests in pick order as source yahoo-dom and is idempotent", () => {
    const picks = [
      { pick: 2, playerName: "Shai Gilgeous-Alexander", nbaTeam: "OKC", positions: "PG,SG" },
      { pick: 1, playerName: "Nikola Jokić", nbaTeam: "DEN", positions: "C" },
    ];
    const r = ingestDomPicks({ db, draftId: id, picks });
    expect(r.ingested).toBe(2);
    expect(r.stoppedReason).toBeNull();
    expect(names()).toEqual(["jokic", "sga"]);
    expect(r.draft.picks.every((p) => p.source === "yahoo-dom")).toBe(true);
    expect(r.draft.currentPick).toBe(3);
    const again = ingestDomPicks({ db, draftId: id, picks });
    expect(again.ingested).toBe(0);
    expect(again.mismatches).toEqual([]);
    expect(names()).toEqual(["jokic", "sga"]);
  });

  it("normalizes suffixes, accents and nickname aliases", () => {
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "Jaren Jackson" }, { pick: 2, playerName: "Nicolas Claxton" }, { pick: 3, playerName: "LUKA DONČIĆ" }] });
    expect(r.ingested).toBe(3);
    expect(names()).toEqual(["jjj", "claxton", "luka"]);
  });

  it("report-only mode (autoCorrect: false): ingests picks >= currentPick and verifies earlier ones without modifying", () => {
    recordPick(db, id, "jokic", "manual");
    const r = ingestDomPicks({
      db, draftId: id, autoCorrect: false,
      picks: [{ pick: 1, playerName: "Luka Doncic" }, { pick: 2, playerName: "Shai Gilgeous-Alexander" }],
    });
    expect(r.mismatches).toEqual([{ pick: 1, ours: "Nikola Jokic", seen: "Luka Doncic" }]);
    expect(r.ingested).toBe(1);
    expect(names()).toEqual(["jokic", "sga"]);
    expect(getDraft(db, id)!.picks[0].source).toBe("manual");
  });

  it("report-only mode: stops at a gap and ingests the rest once the gap is filled", () => {
    const r = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 2, playerName: "Luka Doncic" }, { pick: 3, playerName: "Nic Claxton" }] });
    expect(r.ingested).toBe(0);
    expect(r.stoppedReason).toBe("gap");
    expect(getDraft(db, id)!.picks).toHaveLength(0);
    const r2 = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Luka Doncic" }, { pick: 3, playerName: "Nic Claxton" }] });
    expect(r2.ingested).toBe(3);
  });

  it("report-only mode: an unmapped name stops ingestion at that pick, keeping earlier picks and leaving the rest untouched", () => {
    const r = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Mystery Rookie" }, { pick: 3, playerName: "Luka Doncic" }] });
    expect(r.unmapped).toEqual({ pick: 2, name: "Mystery Rookie", reason: "unmatched" });
    expect(r.ingested).toBe(1);
    expect(getDraft(db, id)!.currentPick).toBe(2);
  });

  it("report-only mode: after a manual fix the unmapped name is not a mismatch and later picks flow", () => {
    ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Mystery Rookie" }] });
    recordPick(db, id, "luka", "manual"); // user's manual fix
    const r = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Mystery Rookie" }, { pick: 3, playerName: "Nic Claxton" }] });
    expect(r.mismatches).toEqual([]);
    expect(r.unmapped).toBeNull();
    expect(r.ingested).toBe(1);
    expect(names()).toEqual(["jokic", "luka", "claxton"]);
  });

  it("report-only mode: breaks same-name ties by team, then by positions; otherwise reports ambiguous", () => {
    const idx = buildNameIndex(db);
    const ok = (team?: string, positions?: string) => matchPlayer(idx, { playerName: "Jalen Williams", nbaTeam: team, positions });
    expect(ok("PHO")).toMatchObject({ ok: true, player: { id: "jw-pho" } }); // Yahoo "PHO" == PHX
    expect(ok("OKC")).toMatchObject({ ok: true, player: { id: "jw-okc" } });
    expect(ok(undefined, "PG")).toMatchObject({ ok: true, player: { id: "jw-pho" } });
    expect(ok()).toMatchObject({ ok: false, reason: "ambiguous" });
    const r = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Jalen Williams" }] });
    expect(r.unmapped).toMatchObject({ pick: 1, reason: "ambiguous" });
    expect(r.unmapped!.candidates).toHaveLength(2);
    expect(getDraft(db, id)!.picks).toHaveLength(0);
  });

  it("an ambiguous name resolves to the undrafted twin", () => {
    recordPick(db, id, "jw-okc", "manual");
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "Jalen Williams" }, { pick: 2, playerName: "Jalen Williams" }] });
    expect(r.mismatches).toEqual([]); // pick 1 is ambiguous without team -> not flagged
    expect(r.ingested).toBe(1);
    expect(names()).toEqual(["jw-okc", "jw-pho"]);
  });

  it("report-only mode: reports a conflict when Yahoo's pick is already drafted at another local pick", () => {
    recordPick(db, id, "jokic", "manual");
    const r = ingestDomPicks({ db, draftId: id, autoCorrect: false, picks: [{ pick: 1, playerName: "Luka Doncic" }, { pick: 2, playerName: "Nikola Jokic" }] });
    expect(r.stoppedReason).toBe("conflict");
    expect(r.conflict).toEqual({ pick: 2, name: "Nikola Jokic", alreadyAtPick: 1 });
    expect(getDraft(db, id)!.picks).toHaveLength(1);
  });

  it("stops at the end of the draft", () => {
    const small = createDraft(db, { teams: 2, userSlot: 1, rounds: 1 }).id;
    const r = ingestDomPicks({ db, draftId: small, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 2, playerName: "Luka Doncic" }, { pick: 3, playerName: "Nic Claxton" }] });
    expect(r.ingested).toBe(2);
    expect(r.stoppedReason).toBe("draft_complete");
    expect(r.draft.status).toBe("complete");
  });

  it("warns when a pick number repeats with different names; empty payloads are fine", () => {
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "Nikola Jokic" }, { pick: 1, playerName: "Luka Doncic" }] });
    expect(r.warnings).toHaveLength(1);
    expect(names()).toEqual(["luka"]);
    expect(ingestDomPicks({ db, draftId: id, picks: [] })).toMatchObject({ ingested: 0, received: 0, highestPick: 0 });
  });

  it("throws DRAFT_NOT_FOUND for an unknown draft", () => {
    expect(() => ingestDomPicks({ db, draftId: 999, picks: [] })).toThrow(/not found/);
  });

  it("canonTeam folds Yahoo abbreviations", () => {
    expect([canonTeam("GS"), canonTeam("NO"), canonTeam("NY"), canonTeam("SA"), canonTeam("PHO"), canonTeam("Utah"), canonTeam("WSH")]).toEqual(["GSW", "NOP", "NYK", "SAS", "PHX", "UTA", "WAS"]);
  });
});

describe("dom-ingest: Yahoo is the source of truth (autoCorrect, default)", () => {
  let db: Db;
  let id: number;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, RECORDS);
    id = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
  });
  const ids = () => getDraft(db, id)!.picks.map((p) => p.playerId);

  it("rewinds to the first pick that differs from Yahoo and replays Yahoo's picks (manual/bot picks replaced)", () => {
    recordPick(db, id, "jokic", "yahoo-dom");
    recordPick(db, id, "luka", "manual"); // wrong: Yahoo has SGA at 2
    recordPick(db, id, "claxton", "simulation"); // wrong: Yahoo has Luka at 3
    const r = ingestDomPicks({
      db, draftId: id,
      picks: [
        { pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" },
        { pick: 2, playerName: "S. Gilgeous-Alexander", nbaTeam: "OKC" },
        { pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" },
        { pick: 4, playerName: "K. Durant", nbaTeam: "HOU" },
      ],
    });
    expect(r.corrected).toMatchObject({ fromPick: 2, removed: 2 });
    expect(ids()).toEqual(["jokic", "sga", "luka", "kd-1"]);
    expect(getDraft(db, id)!.picks.slice(1).every((p) => p.source === "yahoo-dom")).toBe(true);
    expect(r.stoppedReason).toBeNull();
    // idempotent afterwards
    expect(ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" }] }).corrected).toBeNull();
  });

  it("does not rewind for picks Yahoo shows that the app can't map (manual fixes stay)", () => {
    recordPick(db, id, "jokic", "manual");
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "Mystery Rookie" }] });
    expect(r.corrected).toBeNull();
    expect(ids()).toEqual(["jokic"]);
  });
});

describe("matchPlayer: namesakes resolved by ADP / exact positions", () => {
  const db = createDb(":memory:");
  const r = (pid: string, name: string, team: string, pos: PlayerRecord["player"]["positions"], adp: number) => {
    const x = makeRecord({ id: pid, name, positions: pos, market: { yahooAdp: adp, rank: Math.round(adp) } });
    x.player.nbaTeam = team;
    return x;
  };
  seedFromRecords(db, [
    r("stephen-curry", "Stephen Curry", "GSW", ["PG"], 23),
    r("seth-curry", "Seth Curry", "GSW", ["PG", "SG"], 240),
    r("jalen-williams", "Jalen Williams", "OKC", ["SG", "SF"], 35),
    r("jaylin-williams", "Jaylin Williams", "OKC", ["PF", "C"], 190),
    r("a-guard", "Alex Guard", "BOS", ["PG"], 60),
    r("aaron-guard", "Aaron Guard", "BOS", ["PG"], 70),
  ]);
  const index = buildNameIndex(db);

  it("S. Curry GSW PG -> Stephen Curry (the real live-draft failure)", () => {
    const m = matchPlayer(index, { playerName: "S. Curry", nbaTeam: "GSW", positions: "PG" });
    expect(m.ok && m.player.id).toBe("stephen-curry");
  });
  it("J. Williams OKC SF/PF -> Jalen Williams by ADP", () => {
    const m = matchPlayer(index, { playerName: "J. Williams", nbaTeam: "OKC", positions: "SF,PF" });
    expect(m.ok && m.player.id).toBe("jalen-williams");
  });
  it("stays ambiguous when namesakes have close ADPs and identical positions", () => {
    expect(matchPlayer(index, { playerName: "A. Guard", nbaTeam: "BOS", positions: "PG" }).ok).toBe(false);
  });
});

describe("dom-ingest: never stalls in a live draft (default)", () => {
  let db: Db;
  let id: number;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, RECORDS);
    id = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
  });
  const draft = () => getDraft(db, id)!;

  it("unknown player -> placeholder is added and drafted; later picks keep flowing", () => {
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" }, { pick: 2, playerName: "Mystery Rookie", nbaTeam: "SAS", positions: "SG" }, { pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" }] });
    expect(r.unmapped).toBeNull();
    expect(r.autoResolved).toEqual([{ pick: 2, name: "Mystery Rookie", resolution: "placeholder", playerId: "yahoo-mystery-rookie-sas" }]);
    expect(draft().currentPick).toBe(4);
    expect(draft().picks.map((p) => p.playerId)).toEqual(["jokic", "yahoo-mystery-rookie-sas", "luka"]);
    // re-sending is idempotent and the placeholder now matches by name
    expect(ingestDomPicks({ db, draftId: id, picks: [{ pick: 2, playerName: "Mystery Rookie", nbaTeam: "SAS" }] })).toMatchObject({ ingested: 0, corrected: null });
  });

  it("ambiguous namesakes -> best-ADP undrafted candidate", () => {
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "Jalen Williams" }] });
    expect(r.autoResolved[0]).toMatchObject({ pick: 1, resolution: "guessed" });
    expect(draft().currentPick).toBe(2);
  });

  it("skipped pick numbers are held by unknown placeholders, then replaced when Yahoo shows them", () => {
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" }] });
    expect(r.autoResolved.map((a) => a.resolution)).toEqual(["unknown", "unknown"]);
    expect(draft().currentPick).toBe(4);
    const r2 = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" }, { pick: 2, playerName: "S. Gilgeous-Alexander", nbaTeam: "OKC" }, { pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" }] });
    expect(r2.corrected?.fromPick).toBe(1);
    expect(draft().picks.map((p) => p.playerId)).toEqual(["jokic", "sga", "luka"]);
  });

  it("Yahoo player already drafted locally at a pick Yahoo doesn't show -> rewinds there and replays", () => {
    recordPick(db, id, "jokic", "manual");
    recordPick(db, id, "luka", "simulation");
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" }] });
    expect(r.stoppedReason).toBeNull();
    expect(r.corrected?.fromPick).toBe(2);
    expect(draft().picks.map((p) => p.playerId)).toEqual(["jokic", "yahoo-unknown-d" + id + "-p2", "luka"]);
  });
});

describe("dom-ingest: partial / filtered Yahoo lists never wreck the board", () => {
  let db: Db;
  let id: number;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, RECORDS);
    id = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 }).id;
  });
  const ids = () => getDraft(db, id)!.picks.map((p) => p.playerId);

  it("a rewind keeps the recorded picks the payload doesn't show", () => {
    for (const pid of ["jokic", "sga", "jjj", "claxton", "luka", "jw-okc", "jw-pho", "kd-1"]) recordPick(db, id, pid, "yahoo-dom");
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 3, playerName: "A. Thompson", nbaTeam: "HOU" }] });
    expect(r.corrected?.fromPick).toBe(3);
    expect(ids()).toEqual(["jokic", "sga", "amen", "claxton", "luka", "jw-okc", "jw-pho", "kd-1"]);
    expect(r.autoResolved).toEqual([]);
  });

  it("a carried-over pick is dropped when Yahoo places that player elsewhere", () => {
    for (const pid of ["jokic", "sga", "jjj", "claxton", "luka"]) recordPick(db, id, pid, "yahoo-dom");
    // Yahoo: pick 3 is Luka (we had JJJ), pick 6 is Amen. Our Luka at 5 must not be replayed.
    ingestDomPicks({ db, draftId: id, picks: [{ pick: 3, playerName: "L. Doncic", nbaTeam: "LAL" }] });
    expect(ids().slice(0, 4)).toEqual(["jokic", "sga", "luka", "claxton"]);
    expect(ids()).not.toContain("jjj");
  });

  it("a sparse list (e.g. Yahoo showing only my picks) never fills the board with unknown placeholders", () => {
    recordPick(db, id, "jokic", "yahoo-dom");
    recordPick(db, id, "sga", "yahoo-dom");
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" }, { pick: 8, playerName: "K. Durant", nbaTeam: "HOU" }, { pick: 9, playerName: "A. Thompson", nbaTeam: "HOU" }] });
    expect(r.stoppedReason).toBe("gap");
    expect(r.autoResolved).toEqual([]);
    expect(getDraft(db, id)!.currentPick).toBe(3);
    expect(ids()).toEqual(["jokic", "sga"]);
  });

  it("the real failure: a my-picks-only payload late in a full draft changes nothing that is already right", () => {
    const order = ["jokic", "sga", "jjj", "claxton", "luka", "jw-okc", "jw-pho", "kd-1", "amen", "ausar"];
    for (const pid of order) recordPick(db, id, pid, "yahoo-dom");
    // user slot 1 in a 4-team snake: picks 1, 8, 9
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 1, playerName: "N. Jokic", nbaTeam: "DEN" }, { pick: 8, playerName: "K. Durant", nbaTeam: "HOU" }, { pick: 9, playerName: "A. Thompson", nbaTeam: "HOU" }] });
    expect(r.corrected).toBeNull();
    expect(ids()).toEqual(order);
  });
});

describe("header-derived picks (draft-7 final pick corruption)", () => {
  const db0 = () => {
    const db = createDb(":memory:");
    seedFromRecords(db, RECORDS);
    // 10 players, 10 rounds-of-1 → teams 2, rounds 5: picks 1..10; user slot 1
    return { db, id: createDraft(db, { teams: 2, userSlot: 1, rounds: 5 }).id };
  };
  const feed = ["Nikola Jokic", "Shai Gilgeous-Alexander", "Jaren Jackson Jr.", "Nic Claxton", "Luka Doncic", "Jalen Williams", "Kevin Durant", "Amen Thompson", "Ausar Thompson"].map((playerName, i) => ({ pick: i + 1, playerName }));

  it("a header-only payload for an already-recorded pick changes nothing (no rewind, no mismatch)", () => {
    const { db, id } = db0();
    ingestDomPicks({ db, draftId: id, picks: feed });
    const before = getDraft(db, id)!.picks.map((p) => [p.pick, p.playerId]);
    const r = ingestDomPicks({ db, draftId: id, picks: [{ pick: 9, playerName: "Nikola Jokic", via: "header" }] });
    expect(r.corrected).toBeNull();
    expect(r.mismatches).toEqual([]);
    expect(r.ingested).toBe(0);
    expect(getDraft(db, id)!.picks.map((p) => [p.pick, p.playerId])).toEqual(before);
    // then a real payload with pick 10 is appended
    const r2 = ingestDomPicks({ db, draftId: id, picks: [...feed, { pick: 10, playerName: "Jalen Williams", nbaTeam: "PHX" }] });
    expect(r2.ingested).toBe(1);
    expect(getDraft(db, id)!.picks).toHaveLength(10);
  });

  it("a header pick is dropped when the same payload has a real pick for that number; header fills the next pick otherwise", () => {
    const { db, id } = db0();
    const r = ingestDomPicks({ db, draftId: id, picks: [...feed, { pick: 9, playerName: "Nikola Jokic", via: "header" }] });
    expect(r.ingested).toBe(9);
    expect(r.warnings).toEqual([]);
    expect(getDraft(db, id)!.picks[8].playerId).toBe("ausar");
    const r2 = ingestDomPicks({ db, draftId: id, picks: [{ pick: 10, playerName: "Jalen Williams", nbaTeam: "PHX", via: "header" }] });
    expect(r2.ingested).toBe(1);
  });
});
