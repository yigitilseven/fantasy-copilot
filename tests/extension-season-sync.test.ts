import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { discoverLeague, isLoginRedirect, runLeagueSync, sampleAllowed, shouldAutoSync, SYNC_DEFAULTS } from "../extension/parser.js";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures-season-real", f), "utf8");
const ORIGIN = "https://basketball.fantasysports.yahoo.com";
const TXN = `<table><tbody><tr><td>+</td><td><div>Add <a href="https://sports.yahoo.com/nba/players/6001">Ayo Dosunmu</a> <span>MIN - SG,PG</span> from Free Agents to <a href="/nba/100001/9">Copilot Grizzlies</a></div></td><td>Oct 21, 2026 9:30 pm</td></tr></tbody></table>`;

interface Opts { fail?: Record<string, number>; redirect?: string; empty?: string[]; faChain?: boolean; budget?: number }
function harness(o: Opts = {}) {
  let now = Date.parse("2026-10-22T12:00:00Z");
  const requests: { url: string; at: number; method: string }[] = [];
  const posts: { path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sampleStore: Record<string, number> = {};
  const sent: string[] = [];
  let locked = false;
  const lock = { acquire: () => (locked ? false : (locked = true)), touch: () => undefined, release: () => void (locked = false) };
  const page = (u: URL): string => {
    const p = u.pathname;
    if (o.empty?.includes(p)) return "<html><body><p>nothing here</p></body></html>";
    if (/\/nba\/100001\/matchup/.test(p)) return fx("matchup.html");
    if (/\/transactions/.test(p)) return TXN;
    if (/\/players/.test(p)) {
      if (o.faChain) {
        const n = Number(u.searchParams.get("count") || 0);
        return fx("players.html").replace(/count=25/g, `count=${n + 25}`);
      }
      return fx("players.html");
    }
    return fx("team.html");
  };
  const env = {
    origin: ORIGIN,
    doc: new JSDOM(fx("team.html")).window.document,
    href: `${ORIGIN}/nba/100001/9`,
    expectedTeams: 14,
    fetchPage: async (url: string) => {
      const u = new URL(url);
      requests.push({ url, at: now, method: "GET" });
      const code = o.fail?.[u.pathname];
      if (code) return { status: code, url, text: "" };
      return { status: 200, url: o.redirect ?? url, text: page(u) };
    },
    parseHtml: (t: string) => new JSDOM(t).window.document,
    post: async (p: string, body: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      posts.push({ path: p, body });
      if (p === "/api/season/discover") return { status: 200, body: { mapped: 14, unmapped: [], userTeamId: "9", teams: [] } };
      if (p === "/api/season/roster") return { status: 200, body: { matched: 13, added: [], dropped: [], team: { name: "x" } } };
      if (p === "/api/season/matchup") return { status: 200, body: { stored: true, opp: "Manager BG", week: 1 } };
      if (p === "/api/season/transactions") return { status: 200, body: { inserted: 1, applied: 1 } };
      return { status: 200, body: {} };
    },
    sleep: async (ms: number) => void (now += ms),
    now: () => now,
    rand: () => 0.5,
    lock,
    samples: {
      allowed: (k: string) => sampleAllowed(sampleStore, k, now),
      mark: (k: string) => void (sampleStore[k] = now),
      send: async (k: string) => (sent.push(k), true),
    },
  };
  return { env, requests, posts, sent, sampleStore, advance: (ms: number) => void (now += ms), lock };
}

describe("runLeagueSync", () => {
  it("syncs my team, matchup, free agents, transactions and the 13 other rosters, politely", async () => {
    const h = harness();
    const rep = await runLeagueSync(h.env);
    expect(rep.stopped).toBeNull();
    expect(rep.complete).toBe(true);
    const roster = h.posts.filter((p) => p.path === "/api/season/roster");
    expect(roster).toHaveLength(14); // me + 13
    expect(roster[0].body).toMatchObject({ teamId: "9", mine: true, teamName: "Copilot Grizzlies" });
    expect(roster[0].body.players).toHaveLength(13);
    expect(roster.slice(1).every((p) => p.body.mine === false)).toBe(true);
    expect(new Set(roster.map((p) => p.body.teamId)).size).toBe(14);
    expect(h.posts.find((p) => p.path === "/api/season/matchup")!.body.teams).toHaveLength(2);
    expect(h.posts.some((p) => p.path === "/api/season/free-agents")).toBe(true);
    expect(h.posts.some((p) => p.path === "/api/season/transactions")).toBe(true);
    expect(h.posts.at(-1)!.path).toBe("/api/season/sync-report");
    expect(rep.parts.teams).toMatchObject({ ok: 13, total: 13, failed: [] });
    expect(rep.parts.matchup.ok).toBe(true);
  });

  it("only issues same-origin GETs inside the league, at least 2.5 s apart, at most 60", async () => {
    const h = harness();
    await runLeagueSync(h.env);
    expect(h.requests.length).toBeLessThanOrEqual(60);
    expect(h.requests.length).toBeGreaterThan(15);
    for (const r of h.requests) {
      expect(r.method).toBe("GET");
      expect(new URL(r.url).origin).toBe(ORIGIN);
      expect(new URL(r.url).pathname).toMatch(/^\/nba\/100001(\/|$)/);
    }
    for (let i = 1; i < h.requests.length; i++) expect(h.requests[i].at - h.requests[i - 1].at).toBeGreaterThanOrEqual(2500);
    const fa = h.requests.find((r) => r.url.includes("/players"))!;
    expect(fa.url).toContain("status=A");
    expect(fa.url).toContain("sort=AR");
  });

  it("is single flight: a second run while one holds the lock does nothing", async () => {
    const h = harness();
    expect(h.lock.acquire()).toBe(true);
    const rep = await runLeagueSync(h.env);
    expect(rep.skipped).toMatch(/another tab/);
    expect(h.requests).toHaveLength(0);
    h.lock.release();
    expect((await runLeagueSync(h.env)).skipped).toBeNull();
    expect(h.lock.acquire()).toBe(true); // released at the end of a run
  });

  it("stops at the first 4xx/5xx without asking for more pages", async () => {
    const h = harness({ fail: { "/nba/100001/3": 403 } });
    const rep = await runLeagueSync(h.env);
    expect(rep.stopped).toMatch(/HTTP 403/);
    expect(rep.complete).toBe(false);
    const after = h.requests.map((r) => new URL(r.url).pathname);
    expect(after.at(-1)).toBe("/nba/100001/3");
    expect(h.posts.at(-1)!.path).toBe("/api/season/sync-report");
    expect(h.posts.at(-1)!.body.stopped).toMatch(/403/);
  });

  it("stops on a redirect to a login page", async () => {
    const h = harness({ redirect: "https://login.yahoo.com/?.src=fantasy" });
    const rep = await runLeagueSync(h.env);
    expect(rep.stopped).toMatch(/login/);
    expect(h.requests).toHaveLength(1);
    expect(isLoginRedirect("https://login.yahoo.com/x")).toBe(true);
    expect(isLoginRedirect("https://basketball.fantasysports.yahoo.com/nba/1/2")).toBe(false);
    expect(isLoginRedirect("https://basketball.fantasysports.yahoo.com/login?x")).toBe(true);
  });

  it("follows free-agent 'next' links but never more than maxFaPages (20)", async () => {
    const h = harness({ faChain: true });
    const rep = await runLeagueSync(h.env);
    expect(rep.parts.fas.pages).toBe(20);
    expect(h.requests.filter((r) => r.url.includes("/players"))).toHaveLength(20);
    expect(h.posts.filter((p) => p.path === "/api/season/free-agents")).toHaveLength(20);
  });

  it("light run: skips the free-agent crawl while the stored list is fresh; a full run or an old list reads it", async () => {
    const fresh = harness({ faChain: true });
    const light = await runLeagueSync({ ...fresh.env, lastFaAt: "2026-10-22T10:30:00Z" }); // 1.5 h old
    expect(light.parts.fas).toMatchObject({ ok: true, pages: 0, skipped: "list fresh" });
    expect(fresh.requests.filter((r) => r.url.includes("/players"))).toHaveLength(0);
    expect(light.parts.matchup.ok).toBe(true);
    expect(light.parts.transactions.ok).toBe(true);
    const full = harness({ faChain: true });
    expect((await runLeagueSync({ ...full.env, lastFaAt: "2026-10-22T10:30:00Z", fullSync: true })).parts.fas.pages).toBe(20);
    const old = harness({ faChain: true });
    expect((await runLeagueSync({ ...old.env, lastFaAt: "2026-10-22T08:00:00Z" })).parts.fas.pages).toBe(20); // 4 h old
  });

  it("respects the request budget", async () => {
    const h = harness({ faChain: true });
    const rep = await runLeagueSync(h.env, { maxRequests: 6 });
    expect(rep.requests).toBe(6);
    expect(rep.stopped).toMatch(/budget/);
  });

  it("saves a sample for a page that parses to nothing, once per kind per 6 h", async () => {
    const h = harness({ empty: ["/nba/100001/matchup", "/nba/100001/transactions"] });
    const rep = await runLeagueSync(h.env);
    expect(rep.samples.sort()).toEqual(["matchup", "transactions"]);
    expect(h.sent.sort()).toEqual(["matchup", "transactions"]);
    expect(rep.parts.matchup.ok).toBe(false);
    // Same pages again an hour later: no new samples; after 6 h: again.
    h.advance(3_600_000);
    await runLeagueSync(h.env);
    expect(h.sent).toHaveLength(2);
    h.advance(6 * 3_600_000);
    await runLeagueSync(h.env);
    expect(h.sent).toHaveLength(4);
  });

  it("an empty roster page is a failed team plus a roster sample, and the run goes on", async () => {
    const h = harness({ empty: ["/nba/100001/5"] });
    const rep = await runLeagueSync(h.env);
    expect(rep.parts.teams.failed).toEqual([{ id: "5", error: "no player rows found" }]);
    expect(rep.parts.teams.ok).toBe(12);
    expect(rep.samples).toContain("roster");
    expect(rep.complete).toBe(false);
    expect(rep.stopped).toBeNull();
  });
});

describe("triggers and discovery", () => {
  it("auto sync when the last full sync is older than 2 h and no attempt in the last 30 min", () => {
    const now = 10 * 3_600_000;
    expect(shouldAutoSync({ now, lastFullAt: 0, lastAttemptAt: 0, serverAt: 0 })).toBe(true);
    expect(shouldAutoSync({ now, lastFullAt: now - 3_600_000, lastAttemptAt: 0, serverAt: 0 })).toBe(false);
    expect(shouldAutoSync({ now, lastFullAt: now - 3 * 3_600_000, lastAttemptAt: now - 600_000, serverAt: 0 })).toBe(false);
    expect(shouldAutoSync({ now, lastFullAt: now - 3 * 3_600_000, lastAttemptAt: now - 40 * 60_000, serverAt: 0 })).toBe(true);
    expect(shouldAutoSync({ now, lastFullAt: 0, lastAttemptAt: 0, serverAt: now - 60_000 })).toBe(false); // the app already has a recent sync
    expect(SYNC_DEFAULTS.autoEveryMs).toBe(2 * 3_600_000);
  });
  it("discovery from a bare page finds the league id from any link", () => {
    const d = discoverLeague(new JSDOM(`<a href="/nba/555/4">Four</a><a href="/nba/555/5/team?week=1">Five</a><a href="/nba/555/matchup">M</a>`).window.document, "https://basketball.fantasysports.yahoo.com/nba/555/players");
    expect(d.leagueId).toBe("555");
    expect(d.teams).toEqual([{ id: "4", name: "Four" }, { id: "5", name: "Five" }]);
    expect(d.myTeamId).toBeNull();
  });
});
