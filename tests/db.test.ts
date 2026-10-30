import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import {
  DraftError,
  createDraft,
  deleteDraft,
  getAllPlayerRecords,
  getDraft,
  getLatestActiveDraft,
  recordPick,
  resetDraft,
  undoLastPick,
} from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { loadPlayerRecordsFromCsv, parseCsv } from "@/integrations/projections/csv";
import type { PlayerRecord } from "@/types";

const FIX = path.resolve(__dirname, "fixtures-data");
const csvRecords = loadPlayerRecordsFromCsv(FIX);

function drafted(db: Db, id: number) {
  return new Set(getDraft(db, id)!.picks.map((p) => p.playerId));
}

describe("csv", () => {
  it("parses quoted fields", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n')).toEqual([{ a: "x, y", b: 'he said "hi"' }]);
  });
  it("joins the three files", () => {
    expect(csvRecords).toHaveLength(3);
    const j = csvRecords.find((r) => r.player.id === "jokic")!;
    expect(j.player.name).toBe("Jokic, Nikola");
    expect(j.player.positions).toEqual(["C"]);
    expect(csvRecords.find((r) => r.player.id === "curry")!.player.yahooPlayerKey).toBeNull();
    expect(csvRecords.find((r) => r.player.id === "curry")!.risk.majorInjuryHistory).toBe(true);
  });
  it("throws on missing directory files", () => {
    expect(() => loadPlayerRecordsFromCsv(path.join(FIX, "nope"))).toThrow(/Missing CSV file/);
  });
});

describe("repository", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, csvRecords);
  });

  it("seeds, round-trips and is idempotent", () => {
    seedFromRecords(db, csvRecords);
    const all = getAllPlayerRecords(db);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.player.id)).toEqual(["jokic", "curry", "tatum"]); // by rank
    const c = all.find((r) => r.player.id === "curry")!;
    expect(c.player.positions).toEqual(["PG", "SG"]);
    expect(c.projection).toEqual({ ...csvRecords.find((r) => r.player.id === "curry")!.projection, projectionSource: "nba-stats" });
    expect(c.risk).toEqual(csvRecords.find((r) => r.player.id === "curry")!.risk);
  });

  it("creates a draft and drafts a player", () => {
    const d = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 });
    expect(d).toMatchObject({ status: "active", currentPick: 1, picks: [] });
    expect(getLatestActiveDraft(db)!.id).toBe(d.id);
    const s = recordPick(db, d.id, "jokic", "manual");
    expect(s.currentPick).toBe(2);
    expect(drafted(db, d.id).has("jokic")).toBe(true);
    expect(s.picks[0]).toMatchObject({ pick: 1, round: 1, teamSlot: 1, source: "manual" });
  });

  it("rejects duplicates, unknown players and unknown drafts", () => {
    const d = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 });
    recordPick(db, d.id, "jokic", "manual");
    expect(() => recordPick(db, d.id, "jokic", "manual")).toThrow(DraftError);
    try {
      recordPick(db, d.id, "jokic", "manual");
    } catch (e) {
      expect((e as DraftError).code).toBe("PLAYER_ALREADY_DRAFTED");
    }
    expect(() => recordPick(db, d.id, "nobody", "manual")).toThrow(/not found/);
    expect(() => recordPick(db, 999, "curry", "manual")).toThrow(DraftError);
    expect(getDraft(db, d.id)!.currentPick).toBe(2);
  });

  it("undo makes the player available again", () => {
    const d = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 });
    recordPick(db, d.id, "jokic", "manual");
    const s = undoLastPick(db, d.id);
    expect(s.currentPick).toBe(1);
    expect(s.picks).toEqual([]);
    expect(() => recordPick(db, d.id, "jokic", "manual")).not.toThrow();
    expect(() => undoLastPick(db, createDraft(db, { teams: 2, userSlot: 1, rounds: 1 }).id)).toThrow(/No picks/);
  });

  it("reset and delete", () => {
    const d = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 });
    recordPick(db, d.id, "jokic", "manual");
    expect(resetDraft(db, d.id).picks).toEqual([]);
    expect(deleteDraft(db, d.id)).toBe(true);
    expect(getDraft(db, d.id)).toBeNull();
    expect(deleteDraft(db, d.id)).toBe(false);
  });

  it("full 14x13 draft completes with correct snake math", () => {
    const base = csvRecords[0];
    const many: PlayerRecord[] = Array.from({ length: 200 }, (_, i) => {
      const id = `p${i}`;
      return {
        player: { ...base.player, id, name: id },
        projection: { ...base.projection, playerId: id },
        market: { ...base.market, playerId: id, rank: i + 1 },
        risk: { ...base.risk, playerId: id },
      };
    });
    seedFromRecords(db, many);
    const d = createDraft(db, { teams: 14, userSlot: 13, rounds: 13 });
    let s = d;
    for (let i = 0; i < 182; i++) s = recordPick(db, d.id, `p${i}`, "manual");
    expect(s.status).toBe("complete");
    expect(s.currentPick).toBe(183);
    expect(s.picks).toHaveLength(182);
    const at = (n: number) => s.picks.find((p) => p.pick === n)!;
    expect(at(13)).toMatchObject({ round: 1, teamSlot: 13 });
    expect(at(16)).toMatchObject({ round: 2, teamSlot: 13 });
    expect(at(41)).toMatchObject({ round: 3, teamSlot: 13 });
    expect(getLatestActiveDraft(db)).toBeNull();
    expect(() => recordPick(db, d.id, "p190", "manual")).toThrow(/complete/);
    expect(undoLastPick(db, d.id).status).toBe("active");
  });
});
