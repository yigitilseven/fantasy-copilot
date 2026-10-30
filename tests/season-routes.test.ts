import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/season-routes-test-cache`);
vi.mock("@/integrations/projections/stats-lookup", async (orig) => ({ ...(await orig<typeof import("@/integrations/projections/stats-lookup")>()), defaultStatsCacheDir: () => TMP }));

import { createDb, type Db } from "@/db/client";
import { getRosters } from "@/db/season";
import { GET as overviewGet, OPTIONS as overviewOptions } from "@/app/api/season/route";
import { GET as statusGet } from "@/app/api/season/status/route";
import { POST as rosterPost, PATCH as rosterPatch } from "@/app/api/season/roster/route";
import { GET as faGet, POST as faPost } from "@/app/api/season/free-agents/route";
import { POST as matchupPost } from "@/app/api/season/matchup/route";
import { GET as settingsGet, PUT as settingsPut, OPTIONS as settingsOptions } from "@/app/api/season/settings/route";
import { GET as briefGet } from "@/app/api/season/brief/route";
import { resetSeasonPlayerCache } from "@/server/season-players";
import { playerName, seedSeasonLeague } from "./season-fixtures";

const YAHOO = "https://basketball.fantasysports.yahoo.com";
const post = (url: string, body: unknown, method = "POST") => new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", origin: YAHOO }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { origin: YAHOO } });
const nameOf = (id: string) => playerName(Number(id.slice(2)));

let db: Db;
let leagueId: number;
beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  db = createDb(":memory:");
  (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = db;
  resetSeasonPlayerCache(db);
  ({ leagueId } = seedSeasonLeague(db));
});

const mine = () => (getRosters(db, leagueId).get(13) ?? []).map((r) => r.playerId);

describe("season routes", () => {
  it("overview: 404 with a hint when no league exists yet", async () => {
    (globalThis as unknown as { __fantasyDb: unknown }).__fantasyDb = createDb(":memory:");
    const r = await overviewGet(get("/api/season"));
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("LEAGUE_NOT_FOUND");
    expect((await (await statusGet(get("/api/season/status"))).json()).league).toBeNull();
  });

  it("overview: lineup, week, moves, alerts, news, freshness; ?date= selects the day; CORS for yahoo origins incl. private network", async () => {
    const r = await overviewGet(get("/api/season?date=2026-11-03"));
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(YAHOO);
    const o = await r.json();
    expect(o.date).toBe("2026-11-03");
    expect(o.lineup.starters.length).toBeGreaterThan(0);
    expect(o.week.cats.map((c: { cat: string }) => c.cat)).toEqual(["FG%", "FT%", "3PM", "PTS", "REB", "AST", "STL", "BLK", "TO"]);
    expect(Array.isArray(o.moves.items)).toBe(true);
    expect(o.news).toHaveLength(13);
    const pre = await overviewOptions(new Request("http://localhost/api/season", { method: "OPTIONS", headers: { origin: YAHOO, "access-control-request-private-network": "true" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
    expect((await overviewGet(get("/api/season?date=nope"))).status).toBe(400);
  });

  it("roster POST syncs from the page; status shows 'roster synced'; bad team -> 409; bad body -> 400", async () => {
    const ids = mine();
    const players = ids.map((id, i) => ({ playerName: nameOf(id), slot: i < 10 ? "UTIL" : i === 12 ? "IL" : "BN", injuryTag: i === 12 ? "INJ" : undefined }));
    const ok = await rosterPost(post("/api/season/roster", { teamName: "Copilot Grizzlies", teamId: "13", players }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ matched: 13, partial: false, team: { slot: 13 } });
    const st = await (await statusGet(get("/api/season/status"))).json();
    expect(st.league.name).toBe("Test League");
    expect(st.rosterSyncedAt).toBeTruthy();
    expect(st.fetchFreeAgentPages).toBe(true);
    const bad = await rosterPost(post("/api/season/roster", { teamName: "Nobody FC", players }));
    expect(bad.status).toBe(409);
    expect((await bad.json()).code).toBe("TEAM_NOT_FOUND");
    expect((await rosterPost(post("/api/season/roster", { players: [] }))).status).toBe(400);
    const o = await (await overviewGet(get("/api/season?date=2026-11-03"))).json();
    expect(o.freshness.roster.source).toBe("yahoo-page");
    expect(o.lineup.il.map((x: { playerId: string }) => x.playerId)).toEqual([ids[12]]);
    expect(o.lineup.il).toHaveLength(1);
  });

  it("free-agents POST + matchup POST feed the overview", async () => {
    const fas = Array.from({ length: 30 }, (_, i) => ({ yahooId: String(7000 + i), playerName: nameOf(`pl${182 + i}`), pctOwned: 30 - i }));
    const f = await faPost(post("/api/season/free-agents", { players: fas }));
    expect(f.status).toBe(200);
    expect(await f.json()).toMatchObject({ matched: 30, poolSize: 30 });
    const cats = { "FG%": 0.46, "FT%": 0.8, "3PTM": 20, PTS: 300, REB: 110, AST: 60, ST: 14, BLK: 8, TO: 30 };
    const m = await matchupPost(post("/api/season/matchup", { week: null, teams: [{ name: "Copilot Grizzlies", cats }, { name: "Echo FC", cats: { ...cats, PTS: 340 } }] }));
    expect(m.status).toBe(200);
    expect(await m.json()).toMatchObject({ stored: true, opp: "Echo FC" });
    const o = await (await overviewGet(get("/api/season"))).json();
    expect(o.moves.faSource).toBe("captured");
    expect(o.week.matchupCaptured).toBe(true);
    expect(o.week.opponent).toBe("Echo FC");
    expect((await matchupPost(post("/api/season/matchup", { teams: [{ name: "A", cats: {} }, { name: "B", cats: {} }] }))).status).toBe(409);
  });

  it("free-agents GET: scored pool, sorted, filtered by position and name, limited", async () => {
    const fas = Array.from({ length: 30 }, (_, i) => ({ yahooId: String(7000 + i), playerName: nameOf(`pl${182 + i}`), pctOwned: 30 - i }));
    await faPost(post("/api/season/free-agents", { players: fas }));
    const all = await (await faGet(get("/api/season/free-agents?limit=500"))).json();
    expect(all.source).toBe("captured");
    expect(all.count).toBe(30);
    expect(all.players).toHaveLength(30);
    const v = all.players.map((p: { value: number }) => p.value);
    expect(v).toEqual([...v].sort((a: number, b: number) => b - a));
    expect(all.players[0]).toMatchObject({ playerId: expect.any(String), name: expect.any(String), team: expect.any(String), gamesThisWeek: expect.any(Number), status: { flag: expect.any(String) } });
    const owned = await (await faGet(get("/api/season/free-agents?sort=owned&limit=3"))).json();
    expect(owned.players.map((p: { pctOwned: number }) => p.pctOwned)).toEqual([30, 29, 28]);
    const first = all.players[0];
    const byName = await (await faGet(get(`/api/season/free-agents?q=${encodeURIComponent(first.name.slice(1, 6).toUpperCase())}`))).json();
    expect(byName.players.map((p: { playerId: string }) => p.playerId)).toContain(first.playerId);
    const pg = await (await faGet(get("/api/season/free-agents?pos=" + first.positions.split("/")[0]))).json();
    for (const p of pg.players) expect(p.positions.split("/")).toContain(first.positions.split("/")[0]);
    expect((await faGet(get("/api/season/free-agents?pos=XX"))).status).toBe(400);
  });

  it("settings: GET/PUT with sanitizing; adds-used override shows in the overview; PUT is allowed from yahoo origins", async () => {
    expect((await (await settingsGet(get("/api/season/settings"))).json()).settings.weeklyAddLimit).toBe(4);
    const put = await settingsPut(post("/api/season/settings", { settings: { weeklyAddLimit: 3, ilSlots: 1 }, addsUsed: 2 }, "PUT"));
    expect(put.status).toBe(200);
    const j = await put.json();
    expect(j.settings).toMatchObject({ weeklyAddLimit: 3, ilSlots: 1 });
    expect(j.addsOverride).toBe(2);
    const o = await (await overviewGet(get("/api/season"))).json();
    expect(o.week).toMatchObject({ addsUsed: 2, addsLimit: 3, addsRemaining: 1 });
    const pre = settingsOptions(new Request("http://localhost/x", { method: "OPTIONS", headers: { origin: YAHOO, "access-control-request-method": "PUT" } }));
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect((await settingsPut(post("/api/season/settings", { addsUsed: -1 }, "PUT"))).status).toBe(400);
  });

  it("PATCH roster records a manual add/drop/IL move and counts the add", async () => {
    const ids = mine();
    const r = await rosterPatch(post("/api/season/roster", { add: "pl190", drop: ids[0], il: ids[1] }, "PATCH"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.added).toEqual(["pl190"]);
    expect(body.dropped).toEqual([ids[0]]);
    const row = getRosters(db, leagueId).get(13)!;
    expect(row.find((x) => x.playerId === ids[1])).toMatchObject({ status: "il", lineupSlot: "IL" });
    expect(row.find((x) => x.playerId === "pl190")!.source).toBe("manual");
    expect(row).toHaveLength(13);
    expect((await rosterPatch(post("/api/season/roster", {}, "PATCH"))).status).toBe(400);
  });

  it("brief: generated once per day and stored; ?refresh=1 regenerates; ?format=text is plain text", async () => {
    const first = await (await briefGet(get("/api/season/brief"))).json();
    expect(first.created).toBe(true);
    expect(first.sections.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(["Today's lineup", "This week", "Moves", "Data"]));
    expect((await (await briefGet(get("/api/season/brief"))).json()).created).toBe(false);
    expect((await (await briefGet(get("/api/season/brief?refresh=1"))).json()).created).toBe(true);
    const t = await briefGet(get("/api/season/brief?format=text"));
    expect(t.headers.get("content-type")).toContain("text/plain");
    const txt = await t.text();
    expect(txt).toContain("TODAY'S LINEUP");
    expect(txt).toContain("Copilot Grizzlies");
  });
});
