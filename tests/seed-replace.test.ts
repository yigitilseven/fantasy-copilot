import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { createDraft, getAllPlayerRecords, recordPick } from "@/db/repository";
import { playerMarket, playerProjections, playerRisk, players } from "@/db/schema";
import { removeStalePlayers, seedFromRecords } from "@/db/seed";
import { makeRecord } from "./fixtures";

describe("seed --replace (removeStalePlayers)", () => {
  let db: Db;
  const all = ["a", "b", "c", "d"].map((id) => makeRecord({ id, name: `Player ${id}`, market: { rank: id.charCodeAt(0) } }));
  beforeEach(() => {
    db = createDb(":memory:");
    seedFromRecords(db, all);
  });

  it("deletes players (and projection/market/risk rows) that are not in the keep list", () => {
    const r = removeStalePlayers(db, ["a", "b"]);
    expect(r.deleted.map((p) => p.id).sort()).toEqual(["c", "d"]);
    expect(r.keptDrafted).toEqual([]);
    expect(getAllPlayerRecords(db).map((x) => x.player.id)).toEqual(["a", "b"]);
    for (const t of [playerProjections, playerMarket, playerRisk]) expect(db.select().from(t).all()).toHaveLength(2);
  });

  it("keeps (and reports) stale players referenced by any draft pick", () => {
    const d = createDraft(db, { teams: 4, userSlot: 1, rounds: 2 });
    recordPick(db, d.id, "d", "manual");
    const r = removeStalePlayers(db, ["a"]);
    expect(r.deleted.map((p) => p.id).sort()).toEqual(["b", "c"]);
    expect(r.keptDrafted).toEqual([{ id: "d", name: "Player d" }]);
    expect(db.select().from(players).where(eq(players.id, "d")).all()).toHaveLength(1);
    expect(getAllPlayerRecords(db).map((x) => x.player.id).sort()).toEqual(["a", "d"]);
  });

  it("is a no-op when everything is current, and default seeding never deletes", () => {
    expect(removeStalePlayers(db, all.map((x) => x.player.id))).toEqual({ deleted: [], keptDrafted: [] });
    seedFromRecords(db, all.slice(0, 1));
    expect(getAllPlayerRecords(db)).toHaveLength(4);
  });
});
