import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/season-sync-test`);
vi.mock("@/integrations/projections/stats-lookup", async (orig) => ({ ...(await orig<typeof import("@/integrations/projections/stats-lookup")>()), defaultStatsCacheDir: () => TMP }));

import { eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { rosterSnapshots } from "@/db/schema";
import { getAdds, getRosters, getTeams, getTransactions } from "@/db/season";
import { POST as discoverPost } from "@/app/api/season/discover/route";
import { POST as rosterPost } from "@/app/api/season/roster/route";
import { POST as txnPost } from "@/app/api/season/transactions/route";
import { POST as reportPost } from "@/app/api/season/sync-report/route";
import { GET as syncStatusGet } from "@/app/api/season/sync-status/route";
import { GET as reportGet } from "@/app/api/season/report/route";
import { POST as snapshotPost } from "@/app/api/debug/draftroom-snapshot/route";
import { ingestDiscovery, discoverBody } from "@/server/season-ingest";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { playerName, seedSeasonLeague, TEAM_NAMES } from "./season-fixtures";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", origin: YAHOO }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { origin: YAHOO } });
const nameOf = (id: string) => playerName(Number(id.slice(2)));

let db: Db;
let leagueId: number;
// Yahoo team ids are NOT the draft slots: slot s -> id (s * 7) % 15 + 1 is a bijection on 1..14 for this layout.
const yid = (slot: number) => String(((slot * 5) % 14) + 1);
const rosterOf = (slot: number) => (getRosters(db, leagueId).get(slot) ?? []).map((r) => r.playerId);

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  resetSeasonPlayerCache(db);
  ({ leagueId } = seedSeasonLeague(db));
});

const allTeams = () => TEAM_NAMES.map((name, i) => ({ id: yid(i + 1), name }));

describe("discovery", () => {
  it("maps my team by id and the others by name; stores the league key", async () => {
    const r = await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ leagueId: "100001", mapped: 14, unmapped: [], userTeamId: yid(13) });
    const teams = getTeams(db, leagueId);
    expect(teams.map((t) => t.yahooTeamId)).toEqual(Array.from({ length: 14 }, (_, i) => yid(i + 1)));
  });

  it("pairs renamed teams by a shared word, and the last leftover one-to-one", () => {
    const teams = allTeams().map((t) => (t.name === "Alpha FC" ? { ...t, name: "Alpha Renamed" } : t.name === "Bravo FC" ? { ...t, name: "Totally New" } : t));
    const out = ingestDiscovery(db, discoverBody.parse({ leagueId: "100001", myTeamId: yid(13), teams }));
    expect(out.mapped).toBe(14);
    expect(getTeams(db, leagueId).find((t) => t.slot === 1)!.yahooTeamId).toBe(yid(1)); // "Alpha" shared word? (4+ letters: "alpha")
    expect(getTeams(db, leagueId).find((t) => t.slot === 2)!.yahooTeamId).toBe(yid(2)); // last leftover pair
  });

  it("validates the body", async () => {
    expect((await discoverPost(post("/api/season/discover", { leagueId: "abc", teams: [] }))).status).toBe(400);
  });
});

describe("rosters of all 14 teams", () => {
  it("replaces each team's roster from its page (by Yahoo id), keeps snapshots, handles a trade between two teams", async () => {
    await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    const before = new Map(getTeams(db, leagueId).map((t) => [t.slot, rosterOf(t.slot)]));
    for (let slot = 1; slot <= 14; slot++) {
      const ids = before.get(slot)!;
      const players = ids.map((id, i) => ({ yahooId: String(100000 + Number(id.slice(2))), playerName: nameOf(id), slot: i < 10 ? "UTIL" : "BN" }));
      const r = await rosterPost(post("/api/season/roster", { teamId: yid(slot), mine: slot === 13, players }));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ matched: 13, partial: false, team: { slot } });
    }
    for (let slot = 1; slot <= 14; slot++) expect(rosterOf(slot).sort()).toEqual([...before.get(slot)!].sort());
    // Team 2 now shows one of team 1's players instead of its own last one.
    const moved = before.get(1)![0];
    const dropped = before.get(2)![12];
    const players = [...before.get(2)!.slice(0, 12), moved].map((id) => ({ playerName: nameOf(id), slot: "BN" }));
    const r = await (await rosterPost(post("/api/season/roster", { teamId: yid(2), players }))).json();
    expect(r).toMatchObject({ added: [moved], dropped: [dropped], moved: [moved] });
    expect(rosterOf(2)).toContain(moved);
    expect(rosterOf(1)).not.toContain(moved);
    // History: snapshots per sync
    const snaps = db.select().from(rosterSnapshots).where(eq(rosterSnapshots.source, "yahoo-page")).all();
    expect(snaps).toHaveLength(15);
  });

  it("a renamed team is recognised by its roster overlap", async () => {
    const ids = rosterOf(3);
    const players = ids.map((id) => ({ playerName: nameOf(id), slot: "BN" }));
    const r = await rosterPost(post("/api/season/roster", { teamId: "77", teamName: "Brand New Name", players }));
    expect(r.status).toBe(200);
    expect(getTeams(db, leagueId).find((t) => t.slot === 3)!.yahooTeamId).toBe("77");
  });
});

describe("transactions", () => {
  const row = (key: string, date: string, actions: object[], type = "add/drop", time?: string) => ({ key, date, time, type, actions });

  it("applies new adds/drops to the rosters, dedupes by key, counts the user's adds for the week", async () => {
    await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    const free = "pl190";
    const myDrop = rosterOf(13)[12];
    const body = { rows: [row("key-1", "2026-10-21", [{ action: "add", yahooId: "190", name: nameOf(free), teamId: yid(13) }, { action: "drop", yahooId: "1", name: nameOf(myDrop), teamId: yid(13) }], "add/drop", "10:00")] };
    const r = await txnPost(post("/api/season/transactions", body));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ received: 1, inserted: 1, applied: 2, addsRecorded: 1 });
    expect(rosterOf(13)).toContain(free);
    expect(rosterOf(13)).not.toContain(myDrop);
    expect(getRosters(db, leagueId).get(13)!.find((x) => x.playerId === free)!.source).toBe("transaction");
    expect(getTransactions(db, leagueId)).toHaveLength(1);
    expect(getAdds(db, leagueId, "2026-10-19").count).toBe(1);
    // Same page again: nothing new, nothing counted twice.
    expect(await (await txnPost(post("/api/season/transactions", body))).json()).toMatchObject({ inserted: 0, applied: 0, addsRecorded: 0 });
    expect(getAdds(db, leagueId, "2026-10-19").count).toBe(1);
  });

  it("another team's add/drop updates that roster; trades move the player", async () => {
    await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    const t5 = rosterOf(5)[0];
    const t6 = rosterOf(6)[0];
    const r = await (await txnPost(post("/api/season/transactions", { rows: [row("txn-1", "2026-10-20", [{ action: "add", yahooId: "191", name: nameOf("pl191"), teamId: yid(5) }, { action: "drop", yahooId: "2", name: nameOf(t5), teamId: yid(5) }]), row("txn-2", "2026-10-21", [{ action: "trade", yahooId: "3", name: nameOf(t6), teamId: yid(5) }], "trade")] }))).json();
    expect(r.inserted).toBe(2);
    expect(rosterOf(5)).toEqual(expect.arrayContaining(["pl191", t6]));
    expect(rosterOf(5)).not.toContain(t5);
    expect(rosterOf(6)).not.toContain(t6);
  });

  it("skips what a later roster page already reflects, but still counts my adds", async () => {
    await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    const ids = rosterOf(13);
    await rosterPost(post("/api/season/roster", { teamId: yid(13), mine: true, players: ids.map((id) => ({ playerName: nameOf(id), slot: "BN" })) }));
    const r = await (await txnPost(post("/api/season/transactions", { rows: [row("old-1", "2000-01-01", [{ action: "add", yahooId: "190", name: nameOf("pl190"), teamId: yid(13) }], "add")] }))).json();
    expect(r).toMatchObject({ inserted: 1, applied: 0, skippedStale: 1 });
    expect(rosterOf(13)).not.toContain("pl190");
  });
});

describe("sync report, status, samples, report endpoint", () => {
  it("status reflects the last run per part", async () => {
    await discoverPost(post("/api/season/discover", { leagueId: "100001", myTeamId: yid(13), teams: allTeams() }));
    const rep = {
      startedAt: "2026-10-22T10:00:00Z", finishedAt: "2026-10-22T10:02:00Z", requests: 24, stopped: null, complete: true, samples: ["transactions"],
      parts: { discovery: { ok: true, mapped: 14 }, myTeam: { ok: true, count: 13 }, teams: { ok: 13, total: 13, failed: [] }, matchup: { ok: true, opp: "Echo FC" }, fas: { ok: true, rows: 200, pages: 8 }, transactions: { ok: false, rows: 0, error: "no transactions found" } },
    };
    expect((await reportPost(post("/api/season/sync-report", rep))).status).toBe(200);
    const st = await (await syncStatusGet(get("/api/season/sync-status"))).json();
    expect(st.lastFullAt).toBeTruthy();
    expect(st.parts.teams).toEqual({ ok: true, detail: "13/13 teams" });
    expect(st.parts.matchup).toMatchObject({ ok: true });
    expect(st.parts.transactions.ok).toBe(false);
    expect(st.parserNeedsUpdate).toEqual(["transactions"]);
    expect(st.teamsTotal).toBe(14);
  });

  it("debug snapshot: auto samples are saved as season-<kind>-<ts>.html and deduped per kind for 6 h", async () => {
    const orig = process.cwd();
    process.chdir(TMP);
    try {
      const send = (label: string, auto = true) => snapshotPost(post("/api/debug/draftroom-snapshot", { url: "https://x/y", html: "<html>x</html>", text: "x", label, auto }));
      const a = await send("season-roster");
      expect(a.status).toBe(201);
      expect((await a.json()).saved).toMatch(/season-roster-.*\.html$/);
      const b = await send("season-roster");
      expect(b.status).toBe(200);
      expect((await b.json()).skipped).toBe(true);
      expect((await send("season-matchup")).status).toBe(201);
      expect((await send("season-roster", false)).status).toBe(201); // manual snapshots are never deduped
      expect(fs.readdirSync(`${TMP}/data/cache`).filter((f) => f.endsWith(".html"))).toHaveLength(3);
    } finally {
      process.chdir(orig);
    }
  });

  it("report endpoint: summary, ranks for 9 cats, 13 head-to-head rows, moves", async () => {
    const r = await reportGet(get("/api/season/report?date=2026-11-03"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.teams).toHaveLength(14);
    expect(j.cats).toHaveLength(9);
    expect(j.h2h).toHaveLength(13);
    expect(j.h2h[0].winProb).toBeLessThanOrEqual(j.h2h[12].winProb);
    expect(j.summary.length).toBeGreaterThanOrEqual(5);
    expect(j.cats.every((c: { rank: number }) => c.rank >= 1 && c.rank <= 14)).toBe(true);
    expect(j.depth.map((d: { pos: string }) => d.pos)).toEqual(["PG", "SG", "SF", "PF", "C"]);
    expect(Array.isArray(j.drops)).toBe(true);
    expect((await reportGet(get("/api/season/report?date=nope"))).status).toBe(400);
  });
});
