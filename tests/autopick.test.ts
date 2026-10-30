import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { DraftError, autopick, createDraft, getDraft, recordPick, undoToPick } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { makeRecord } from "./fixtures";
import type { PlayerRecord, Position } from "@/types";

const POS: Position[][] = [["PG"], ["SG"], ["SF"], ["PF"], ["C"]];
const records: PlayerRecord[] = Array.from({ length: 80 }, (_, i) =>
  makeRecord({
    id: `q${i + 1}`,
    positions: POS[i % 5],
    projection: { pts: 25 - i * 0.2 },
    market: { yahooAdp: i + 1, adpStdDev: 2 + i * 0.05, rank: i + 1 },
  }),
);

describe("autopick / undoToPick", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, records);
  });

  it("picks bots until the user's slot, never the user's", () => {
    const d = createDraft(db, { teams: 6, userSlot: 4, rounds: 5 });
    const s = autopick(db, d.id, { seed: 1 });
    expect(s.currentPick).toBe(4);
    expect(s.picks).toHaveLength(3);
    expect(s.picks.every((p) => p.source === "simulation")).toBe(true);
    // user is on the clock: no-op
    expect(autopick(db, d.id).picks).toHaveLength(3);
    recordPick(db, d.id, "q60", "manual");
    const s2 = autopick(db, d.id, { seed: 1 });
    // picks 5..6 (teams 5,6), 7..9 (round 2 descending: 6,5,4 -> user at 9)
    expect(s2.currentPick).toBe(9);
    expect(s2.picks.filter((p) => p.teamSlot === 4)).toHaveLength(1);
  });

  it("is deterministic with a seed and respects count", () => {
    const a = createDraft(db, { teams: 6, userSlot: 6, rounds: 5 });
    const b = createDraft(db, { teams: 6, userSlot: 6, rounds: 5 });
    const ids = (id: number) => getDraft(db, id)!.picks.map((p) => p.playerId);
    autopick(db, a.id, { seed: 9 });
    autopick(db, b.id, { seed: 9 });
    expect(ids(a.id)).toEqual(ids(b.id));
    const c = createDraft(db, { teams: 6, userSlot: 6, rounds: 5 });
    autopick(db, c.id, { count: 2, seed: 9 });
    expect(getDraft(db, c.id)!.currentPick).toBe(3);
    expect(new Set(ids(a.id)).size).toBe(5);
  });

  it("stops at each of the user's turns across rounds", () => {
    const d = createDraft(db, { teams: 4, userSlot: 1, rounds: 3 });
    recordPick(db, d.id, "q1");
    const s = autopick(db, d.id, { seed: 3 }); // picks 2-4, then 5 (team 4) ... until user slot 1 at pick 8
    expect(s.currentPick).toBe(8);
    recordPick(db, d.id, "q70");
    expect(autopick(db, d.id, { seed: 3 }).currentPick).toBe(9);
  });

  it("rejects completed/missing drafts", () => {
    expect(() => autopick(db, 999)).toThrow(DraftError);
    const d = createDraft(db, { teams: 2, userSlot: 1, rounds: 1 });
    recordPick(db, d.id, "q1");
    recordPick(db, d.id, "q2");
    expect(() => autopick(db, d.id)).toThrow(/complete/);
  });

  it("undoToPick rolls back to the given pick", () => {
    const d = createDraft(db, { teams: 6, userSlot: 4, rounds: 5 });
    autopick(db, d.id, { seed: 1 });
    recordPick(db, d.id, "q60");
    autopick(db, d.id, { seed: 1 });
    const s = undoToPick(db, d.id, 4);
    expect(s.currentPick).toBe(4);
    expect(s.picks).toHaveLength(3);
    expect(s.status).toBe("active");
    expect(() => undoToPick(db, d.id, 9)).toThrow(DraftError);
  });
});
