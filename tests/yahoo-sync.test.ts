import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { createDraft, getDraft, recordPick } from "@/db/repository";
import { seedFromRecords } from "@/db/seed";
import { YahooDraftProvider, buildKeyMapper, playerKeySuffix } from "@/integrations/yahoo/draft-provider";
import { YahooError } from "@/integrations/yahoo/errors";
import type { YahooDraftResult } from "@/integrations/yahoo/normalize";
import { syncYahooDraft } from "@/integrations/yahoo/sync";
import { makeRecord } from "./fixtures";
import { fakeGet } from "./yahoo-helpers";

const KEYS: Record<string, string> = { a: "466.p.1", b: "466.p.2", c: "466.p.3", d: "466.p.4", e: "466.p.5" };
let db: Db;
let draftId: number;

function results(...picks: [number, string | null][]): YahooDraftResult[] {
  return picks.map(([pick, k]) => ({ pick, round: 1, teamKey: `466.l.9.t.${pick}`, yahooPlayerKey: k }));
}
const fetcherOf = (rows: YahooDraftResult[]) => ({ calls: 0, async fetchDraftResults() { this.calls++; return rows; } });

beforeEach(() => {
  db = createDb(":memory:");
  seedFromRecords(db, Object.entries(KEYS).map(([id, key], i) => {
    const r = makeRecord({ id, market: { rank: i + 1, yahooAdp: i + 1 } });
    r.player.yahooPlayerKey = key;
    return r;
  }));
  draftId = createDraft(db, { teams: 2, userSlot: 1, rounds: 3 }).id;
});

describe("syncYahooDraft", () => {
  it("ingests only new picks, in order, with source yahoo", async () => {
    const f = fetcherOf(results([1, "466.p.1"], [2, "466.p.2"], [3, "466.p.3"]));
    const r = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f });
    expect(r.ingested).toBe(3);
    expect(r.unmapped).toEqual([]);
    expect(r.draft.currentPick).toBe(4);
    expect(r.draft.picks.map((p) => [p.pick, p.playerId, p.source])).toEqual([[1, "a", "yahoo"], [2, "b", "yahoo"], [3, "c", "yahoo"]]);
    expect(r.draft.picks.map((p) => p.teamSlot)).toEqual([1, 2, 2]); // snake order computed by the repository
  });

  it("is idempotent and picks up only the delta on later polls", async () => {
    const rows = results([1, "466.p.1"], [2, "466.p.2"]);
    const f = { async fetchDraftResults() { return rows; } };
    expect((await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f })).ingested).toBe(2);
    expect((await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f })).ingested).toBe(0);
    rows.push(...results([3, "466.p.3"]));
    const r = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f });
    expect(r.ingested).toBe(1);
    expect(r.draft.picks).toHaveLength(3);
  });

  it("skips picks already entered manually and reports mismatches without altering them", async () => {
    recordPick(db, draftId, "a", "manual");
    recordPick(db, draftId, "d", "manual"); // wrong: Yahoo says b at pick 2
    const r = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: fetcherOf(results([1, "466.p.1"], [2, "466.p.2"], [3, "466.p.3"])) });
    expect(r.ingested).toBe(1);
    expect(r.mismatches).toEqual([{ pick: 2, ours: "d", yahoo: "b" }]);
    expect(r.draft.picks.map((p) => p.playerId)).toEqual(["a", "d", "c"]);
  });

  it("stops before an unmapped player and leaves the draft consistent", async () => {
    const f = fetcherOf(results([1, "466.p.1"], [2, "466.p.999"], [3, "466.p.3"]));
    const r = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f });
    expect(r.ingested).toBe(1);
    expect(r.unmapped).toEqual([{ pick: 2, yahooPlayerKey: "466.p.999" }]);
    expect(r.draft.currentPick).toBe(2);
    // user fixes manually, next sync continues
    recordPick(db, draftId, "b", "manual");
    const r2 = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f });
    expect(r2.ingested).toBe(1);
    expect(r2.draft.picks.map((p) => p.playerId)).toEqual(["a", "b", "c"]);
  });

  it("stops at gaps and conflicts, ignores unfilled slots", async () => {
    const gap = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: fetcherOf(results([1, "466.p.1"], [3, "466.p.3"], [4, null])) });
    expect(gap).toMatchObject({ ingested: 1, stoppedReason: "gap", yahooPicks: 1 });
    // Yahoo repeats a player we already drafted at a different slot
    const conflict = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: fetcherOf(results([1, "466.p.1"], [2, "466.p.1"])) });
    expect(conflict).toMatchObject({ ingested: 0, stoppedReason: "conflict" });
    expect(getDraft(db, draftId)!.currentPick).toBe(2);
  });

  it("a failing Yahoo fetch propagates and writes nothing", async () => {
    const f = { async fetchDraftResults(): Promise<YahooDraftResult[]> { throw new YahooError("NETWORK", "down"); } };
    await expect(syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: f })).rejects.toMatchObject({ code: "NETWORK" });
    expect(getDraft(db, draftId)!.picks).toHaveLength(0);
  });

  it("unknown draft -> DRAFT_NOT_FOUND", async () => {
    await expect(syncYahooDraft({ db, draftId: 999, leagueKey: "L", fetcher: fetcherOf([]) })).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  it("marks the draft complete and then reports draft_complete", async () => {
    const rows = results([1, "466.p.1"], [2, "466.p.2"], [3, "466.p.3"], [4, "466.p.4"], [5, "466.p.5"], [6, "466.p.1"]);
    const r = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: fetcherOf(rows.slice(0, 5)) });
    expect(r.draft.status).toBe("active");
    const r2 = await syncYahooDraft({ db, draftId, leagueKey: "L", fetcher: fetcherOf(rows) });
    expect(r2.ingested).toBe(0);
  });
});

describe("YahooDraftProvider (fixtures)", () => {
  it("fetches draft results (drops unfilled slots), leagues with user slot, and config", async () => {
    const p = new YahooDraftProvider(fakeGet().get);
    const dr = await p.fetchDraftResults("466.l.12345");
    expect(dr).toHaveLength(6);
    expect(dr.every((r) => r.yahooPlayerKey)).toBe(true);
    const leagues = await p.fetchLeagues();
    expect(leagues.map((l) => [l.leagueKey, l.userSlot])).toEqual([["466.l.12345", 6], ["466.l.67890", 2]]);
    const cfg = await p.fetchConfig("466.l.12345");
    expect(cfg).toMatchObject({ numTeams: 14, draftType: "live", rounds: 13, userSlot: 6, userTeamKey: "466.l.12345.t.6" });
  });

  it("key mapper ignores game-key prefixes", () => {
    expect(playerKeySuffix("466.p.5352")).toBe("p.5352");
    const m = buildKeyMapper(db);
    expect(m("999.p.1")).toBe("a");
    expect(m("466.p.404")).toBeNull();
  });
});
