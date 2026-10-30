import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Season mode against the real app on :3100: bootstrap a league from a bot-filled draft, read the page, sync a roster page like the userscript does.
const SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../extension/yahoo-draft-reader.user.js"), "utf8");

test("Copilot screens: empty state, then Today, Matchup, Moves, League and Settings for a bootstrapped league", async ({ page, request }) => {
  await page.goto("/season"); // old URL redirects to Today
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("no-league-state")).toBeVisible();

  const draft = await (await request.post("/api/draft", { data: { teams: 14, userSlot: 13, rounds: 13 } })).json();
  // Bots never pick for the user: alternate bot picks with the user taking the best remaining player until the draft completes.
  const pool = ((await (await request.get("/api/players")).json()) as { player: { id: string }; market: { rank: number } }[]).sort((a, b) => a.market.rank - b.market.rank);
  let state = draft as { status: string; picks: { playerId: string }[] };
  for (let i = 0; i < 20 && state.status !== "complete"; i++) {
    state = await (await request.post(`/api/draft/${draft.id}/autopick`, { data: { seed: 5 + i } })).json();
    if (state.status === "complete") break;
    const taken = new Set(state.picks.map((p) => p.playerId));
    state = await (await request.post(`/api/draft/${draft.id}/pick`, { data: { playerId: pool.find((p) => !taken.has(p.player.id))!.player.id } })).json();
  }
  expect(state.status).toBe("complete");
  const init = await request.post("/api/season/init", { data: { draftId: draft.id } });
  expect(init.status()).toBe(201);

  await page.goto("/today");
  await expect(page.getByTestId("copilot-shell")).toBeVisible();
  await expect(page.getByTestId("today")).toBeVisible();
  await expect(page.getByTestId("win-prob").first()).toHaveText(/\d+%/);
  await expect(page.getByTestId("cat-grid").first().locator("> div")).toHaveCount(9);

  await page.goto("/matchup");
  await expect(page.getByTestId("win-prob").first()).toHaveText(/\d+%/);
  await page.goto("/moves");
  await expect(page.getByTestId("moves")).toBeVisible();
  await page.goto("/league");
  await expect(page.getByTestId("league-tab")).toBeVisible();

  // Settings round trip
  await page.goto("/settings");
  await page.getByTestId("setting-weeklyAddLimit").fill("5");
  await page.getByTestId("setting-save").click();
  await expect(page.getByTestId("settings-league")).toContainText("Saved");
  await page.goto("/today");
  await expect(page.getByTestId("today")).toContainText("/5 used");

  // Link in the draft top bar
  await page.goto("/draft");
  await expect(page.getByTestId("season-link")).toHaveAttribute("href", "/today");
});

test("userscript on a fake Yahoo My Team page: reads the roster, posts it, overlay says 'roster synced'", async ({ page, request }) => {
  const lg = await (await request.get("/api/season")).json();
  test.skip(!lg.league, "needs the league created by the previous test");
  const mine = (lg.roster as { name: string; team: string; positions: string }[]).slice(0, 8);
  const fixture = fs.readFileSync(path.resolve(__dirname, "../fixtures-extension/season-team.html"), "utf8");
  const rows = mine.map((p, i) => `<tr><td class="pos">${["PG", "SG", "G", "SF", "PF", "F", "C", "BN"][i]}</td><td class="player"><div class="ysf-player-name"><a class="name" href="/nba/players/${8000 + i}">${p.name}</a><span class="Fz-xxs">${p.team} - ${p.positions.replace(/\//g, ",")}</span></div></td><td>@ LAL</td></tr>`).join("");
  const html = fixture.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${rows}</tbody>`).replace("Copilot Grizzlies", lg.league.userTeam).replace("<title>Copilot Grizzlies", `<title>${lg.league.userTeam}`);
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.context().grantPermissions(["local-network-access"], { origin: "https://basketball.fantasysports.yahoo.com" });
  // Keep the automatic league sync quiet in the tests below that exercise single pages.
  await page.addInitScript(() => {
    try {
      const v = JSON.parse(localStorage.getItem("fdc:season") || "{}");
      v.lastFullAt = Date.now();
      localStorage.setItem("fdc:season", JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  });
  await page.addInitScript(() => ((window as unknown as { __FDC_ORIGIN: string }).__FDC_ORIGIN = "http://localhost:3100"));
  await page.goto("https://basketball.fantasysports.yahoo.com/nba/100001/13");
  await page.addScriptTag({ content: SCRIPT });
  await expect(page.locator("[data-fdc=season-overlay]")).toBeVisible();
  await expect(page.locator("[data-fdc=season-line]")).toContainText(/roster synced \d+[smh] ago/, { timeout: 20_000 });
  await expect(page.locator("[data-fdc=season-page]")).toContainText("team roster (8 rows read)");
  const st = await (await request.get("/api/season/status")).json();
  expect(st.rosterSyncedAt).toBeTruthy();
  // Read-only: the script never clicks or submits (no extra requests to yahoo besides the page itself).
});

test("userscript on a fake Players page: reads the list, then the next pages with plain GETs (<= 1 per 2 s), never anything else", async ({ page, request }) => {
  const lg = await (await request.get("/api/season")).json();
  test.skip(!lg.league, "needs the league created by the first test");
  const base = fs.readFileSync(path.resolve(__dirname, "../fixtures-extension/season-players.html"), "utf8");
  const seen: { method: string; url: string; at: number }[] = [];
  await page.context().grantPermissions(["local-network-access"], { origin: "https://basketball.fantasysports.yahoo.com" });
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => {
    const u = new URL(r.request().url());
    seen.push({ method: r.request().method(), url: u.pathname + u.search, at: Date.now() });
    const count = Number(u.searchParams.get("count") ?? 0);
    // every page has distinct yahoo ids; page 0 links to count=25 and count=50 (the fixture's pagination)
    const html = base.replace(/players\/70(\d\d?)/g, (_m, d) => `players/${7000 + count * 10 + Number(d)}`);
    return r.fulfill({ contentType: "text/html", body: html });
  });
  // Keep the automatic league sync quiet in the tests below that exercise single pages.
  await page.addInitScript(() => {
    try {
      const v = JSON.parse(localStorage.getItem("fdc:season") || "{}");
      v.lastFullAt = Date.now();
      localStorage.setItem("fdc:season", JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  });
  await page.addInitScript(() => ((window as unknown as { __FDC_ORIGIN: string }).__FDC_ORIGIN = "http://localhost:3100"));
  await page.goto("https://basketball.fantasysports.yahoo.com/nba/100001/players?status=A&pos=O&sort=AR&sdir=1&count=0");
  await page.addScriptTag({ content: SCRIPT });
  await expect(page.locator("[data-fdc=season-crawl]")).toContainText("read 2 more page(s)", { timeout: 25_000 });
  const gets = seen.filter((s) => s.url.includes("count=25") || s.url.includes("count=50"));
  expect(gets.map((g) => g.method)).toEqual(["GET", "GET"]);
  expect(gets[1].at - gets[0].at).toBeGreaterThanOrEqual(1900);
  expect(seen.every((s) => s.method === "GET")).toBe(true); // nothing but GETs ever reached Yahoo
  const st = await (await request.get("/api/season/status")).json();
  expect(st.freeAgents).toBe(9);
  // toggle off: a fresh load of another filter reads only the visible page
  await page.evaluate(() => localStorage.setItem("fdc:season", JSON.stringify({ crawl: false })));
  seen.length = 0;
  await page.goto("https://basketball.fantasysports.yahoo.com/nba/100001/players?status=A&pos=G&sort=AR&sdir=1&count=0");
  await page.addScriptTag({ content: SCRIPT });
  await expect(page.locator("[data-fdc=season-page]")).toContainText("players list (3 rows read)");
  await page.waitForTimeout(2500);
  expect(seen.filter((s) => s.url.includes("count=25"))).toHaveLength(0);
});


test("autonomous league sync: one reload of a league page reads all 14 rosters, matchup, free agents and transactions (GET only), chips show it, parser samples are saved when a page is unreadable", async ({ page, request }) => {
  test.setTimeout(120_000);
  const lg = await (await request.get("/api/season")).json();
  test.skip(!lg.league, "needs the league created by the first test");
  const mine = (lg.roster as { name: string; team: string; positions: string }[]).slice(0, 8);
  const pool = ((await (await request.get("/api/players")).json()) as { player: { name: string; nbaTeam: string; positions: string[] }; market: { rank: number } }[])
    .sort((a, b) => a.market.rank - b.market.rank)
    .map((x) => ({ name: x.player.name, team: x.player.nbaTeam, positions: x.player.positions.join("/") }))
    .filter((x) => !mine.some((m) => m.name === x.name));
  const real = (f: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures-season-real", f), "utf8");
  const SLOTS = ["PG", "SG", "G", "SF", "PF", "F", "C", "BN"];
  const rowsOf = (list: { name: string; team: string; positions: string }[], seed: number) =>
    list.map((p, i) => `<tr data-pos="${SLOTS[i]}"><td class="pos"><span class="pos-label">${SLOTS[i]}</span></td><td class="player"><div class="ysf-player-name"><a class="name" href="https://sports.yahoo.com/nba/players/${seed + i}">${p.name}</a><span class="Fz-xxs">${p.team} - ${p.positions.replace(/\//g, ",")}</span></div></td><td>@LAL</td></tr>`).join("");
  // Switcher names = the app's team names (Team k); Yahoo ids are not the draft slots (my id 9 is the user, "Team 13").
  const slotOfId = (id: number) => (id === 9 ? 13 : id < 9 ? id : id < 14 ? id - 1 : 14);
  const teamPage = (id: number) => {
    const slot = slotOfId(id);
    const list = slot === 13 ? mine : pool.slice(slot * 8, slot * 8 + 8);
    let h = real("team.html").replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rowsOf(list, 9000 + slot * 10)}</tbody>`).replace(/Copilot Grizzlies/g, `Team ${slot}`);
    h = h.replace(/(href="\/nba\/100001\/(\d+)\/team[^"]*">)[^<]*</g, (_m, a, n) => `${a}Team ${slotOfId(Number(n))}<`);
    return h;
  };
  const seen: { method: string; path: string }[] = [];
  await page.context().grantPermissions(["local-network-access"], { origin: "https://basketball.fantasysports.yahoo.com" });
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => {
    const u = new URL(r.request().url());
    seen.push({ method: r.request().method(), path: u.pathname + u.search });
    if (/\/matchup/.test(u.pathname)) return r.fulfill({ contentType: "text/html", body: real("matchup.html").replace(/Copilot Grizzlies/g, lg.league.userTeam).replace(/Manager BG/g, "Team 12").replace(/week=1&/g, `week=${lg.week.number ?? 1}&`) }); // the saved page is from week 1: follow the current week (another week's matchup is ignored by design)
    if (/\/transactions/.test(u.pathname)) return r.fulfill({ contentType: "text/html", body: "<html><body>No transactions</body></html>" });
    if (/\/players/.test(u.pathname)) return r.fulfill({ contentType: "text/html", body: real("players.html").replace(/<a href="[^"]*count=25">Next 25<\/a>/, "") });
    const m = /\/nba\/100001\/(\d+)$/.exec(u.pathname);
    if (m) return r.fulfill({ contentType: "text/html", body: teamPage(Number(m[1])) });
    return r.fulfill({ contentType: "text/html", body: teamPage(9) });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __FDC_ORIGIN: string; __FDC_SYNC_PACE_MS: number };
    w.__FDC_ORIGIN = "http://localhost:3100";
    w.__FDC_SYNC_PACE_MS = 150;
  });
  await page.goto("https://basketball.fantasysports.yahoo.com/nba/100001/9");
  await page.addScriptTag({ content: SCRIPT });
  await expect(page.locator("[data-fdc=season-sync-line]")).toContainText(/League synced .*roster 8 .*14\/14 teams/, { timeout: 90_000 });
  const st = await (await request.get("/api/season/sync-status")).json();
  expect(st.teamsSynced).toBe(14);
  expect(st.parts.teams.ok).toBe(true);
  expect(st.parts.matchup.ok).toBe(true);
  expect(st.parts.fas.ok).toBe(true);
  expect(seen.every((s) => s.method === "GET")).toBe(true);
  // The transactions page had nothing readable: a sample was saved automatically and the chip says so.
  expect(st.parserNeedsUpdate).toContain("transactions");
  await expect(page.locator("[data-fdc=season-calibration]")).toContainText("transactions");
  // App side: sync parts in Settings, league analysis
  await page.goto("/settings");
  await expect(page.getByTestId("sync-parts")).toContainText("13/13 teams");
  await page.goto("/league/h2h");
  await expect(page.getByTestId("league-h2h")).toBeVisible();
  await page.goto("/league/categories");
  await expect(page.getByTestId("league-cats")).toContainText("FG%");
});
