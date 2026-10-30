import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const YAHOO_URL = "https://basketball.fantasysports.yahoo.com/nba/12345/draft";
const APP = "http://localhost:3100";
const SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../extension/yahoo-draft-reader.user.js"), "utf8");

interface PlayersRes { player: { id: string; name: string; nbaTeam: string; positions: string[] }; market: { rank: number } }

async function newDraft(request: APIRequestContext): Promise<number> {
  const res = await request.post("/api/draft", { data: {} });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}
async function topPlayers(request: APIRequestContext): Promise<PlayersRes[]> {
  return ((await (await request.get("/api/players")).json()) as PlayersRes[]).sort((a, b) => a.market.rank - b.market.rank);
}

const rowHtml = (n: number, name: string, team: string, pos: string) =>
  `<tr class="pickrow"><td class="first">${n}.</td><td class="player"><a class="name F-link" href="https://sports.yahoo.com/nba/players/${n}/">${name}</a> <span class="Fz-xxs">${team} - ${pos}</span></td><td><a href="/nba/12345/${n}">Team ${n}</a></td></tr>`;

/** A fake Yahoo draft room: an available-players pool (distractor) plus a Draft Results table that grows. */
const ROOM = `<!doctype html><html><head><title>Draft Room</title></head><body>
<div class="PlayerPool"><table><tr><td>1</td><td>Some Pool Guy</td><td>BOS - PG</td><td>ADP 1.0</td><td><button>Draft</button></td></tr></table></div>
<div class="clock">0:45</div>
<div id="drafttables"><h3>Draft Results</h3><table><tbody id="results"></tbody></table></div>
</body></html>`;

async function openRoom(page: Page, opts: { gm: boolean }) {
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => r.fulfill({ contentType: "text/html", body: ROOM }));
  await page.addInitScript((origin) => {
    (window as unknown as { __FDC_ORIGIN: string }).__FDC_ORIGIN = origin;
  }, APP);
  if (opts.gm) {
    // GM.xmlHttpRequest shim: the real one is performed by the browser extension (no CORS, no mixed-content); here Node does it.
    await page.exposeFunction("__gmRequest", async (d: { method: string; url: string; headers?: Record<string, string>; data?: string }) => {
      const res = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data });
      return { status: res.status, text: await res.text() };
    });
    await page.addInitScript(() => {
      type D = { method: string; url: string; headers?: Record<string, string>; data?: string; onload: (r: { status: number; responseText: string }) => void; onerror: () => void };
      (window as unknown as { GM: unknown }).GM = {
        xmlHttpRequest(d: D) {
          (window as unknown as { __gmRequest: (d: unknown) => Promise<{ status: number; text: string }> })
            .__gmRequest({ method: d.method, url: d.url, headers: d.headers, data: d.data })
            .then((r) => d.onload({ status: r.status, responseText: r.text }), () => d.onerror());
        },
      };
    });
  }
  await page.goto(YAHOO_URL);
  await page.addScriptTag({ content: SCRIPT });
}

const addPick = (page: Page, n: number, p: PlayersRes["player"]) =>
  page.evaluate((html) => document.getElementById("results")!.insertAdjacentHTML("beforeend", html), rowHtml(n, p.name, p.nbaTeam, p.positions.join(",")));
const overlay = (page: Page, key: string) => page.locator(`[data-fdc="${key}"]`);
/** The sync details (draft id, parsed count, buttons) sit behind the overlay's "..." toggle. */
const openDetails = async (page: Page) => {
  if (!(await overlay(page, "snapshot-btn").isVisible())) await overlay(page, "more").click();
};

test("userscript -> board: picks appearing in a fake Yahoo draft room advance /draft; unknown player never stalls; wrong local pick auto-corrected; snapshot", async ({ context, request }) => {
  const id = await newDraft(request);
  const top = await topPlayers(request);

  const app = await context.newPage();
  await app.goto("/draft");
  await expect(app.getByTestId("current-pick")).toHaveText("1");
  await expect(app.getByTestId("browser-status")).toHaveText("Browser sync: off");

  // enable browser sync: manual mode, bots locked
  await app.getByTestId("mode-mock").click();
  await app.getByTestId("browser-status").click();
  await app.getByTestId("browser-toggle").check();
  await expect(app.getByTestId("mode-manual")).toHaveAttribute("aria-pressed", "true");
  await expect(app.getByTestId("mode-mock")).toBeDisabled();
  await expect(app.getByTestId("new-mock-button")).toBeDisabled();
  await expect(app.getByTestId("browser-status")).toContainText("waiting");

  const yahoo = await context.newPage();
  await openRoom(yahoo, { gm: true });
  await expect(overlay(yahoo, "conn")).toContainText("Connected to localhost:3100");
  await openDetails(yahoo);
  await expect(overlay(yahoo, "draft")).toContainText(`Draft id: ${id}`);
  await expect(overlay(yahoo, "error")).toContainText("No picks detected");
  // heartbeat from an empty room already marks the app as live
  await expect(app.getByTestId("browser-status")).toContainText("live", { timeout: 10_000 });

  // picks 1-3 appear -> board advances to 4 without any input in the app
  for (let i = 0; i < 3; i++) await addPick(yahoo, i + 1, top[i].player);
  await expect(app.getByTestId("current-pick")).toHaveText("4", { timeout: 15_000 });
  await expect(app.getByTestId("pick-log-item")).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(app.locator(`[data-player-id="${top[i].player.id}"]`)).toHaveCount(0);
  await expect(overlay(yahoo, "parsed")).toContainText("Parsed on page: 3");
  await expect(overlay(yahoo, "last")).toContainText("Last pick sent: 3");
  await expect(app.getByTestId("browser-status")).toContainText("live");
  const api = (await (await request.get(`/api/draft/${id}`)).json()) as { picks: { source: string }[] };
  expect(api.picks.map((p) => p.source)).toEqual(["yahoo-dom", "yahoo-dom", "yahoo-dom"]);

  // bots can't fight the live draft
  await expect(app.getByTestId("sim-to-pick")).toBeDisabled();

  // an unknown name never stalls the live draft: it is added as a placeholder and the board keeps moving
  await yahoo.evaluate(() => document.getElementById("results")!.insertAdjacentHTML("beforeend", `<tr><td>4.</td><td><a class="name" href="https://sports.yahoo.com/nba/players/9/">Zzyzx Mysteryman</a> <span>BOS - PG</span></td><td>Team 4</td></tr>`));
  await expect(app.getByTestId("current-pick")).toHaveText("5", { timeout: 15_000 });
  await expect(overlay(yahoo, "info")).toContainText("added unknown: Zzyzx Mysteryman");
  await addPick(yahoo, 5, top[3].player);
  await expect(app.getByTestId("current-pick")).toHaveText("6", { timeout: 15_000 });

  // a wrong pick entered by hand is replaced by what Yahoo shows (Yahoo is the source of truth)
  const wrong = top[12].player;
  const r = await request.post(`/api/draft/${id}/pick`, { data: { playerId: wrong.id, source: "manual" } });
  expect(r.ok()).toBe(true);
  await addPick(yahoo, 6, top[4].player);
  await expect(app.getByTestId("current-pick")).toHaveText("7", { timeout: 15_000 });
  await expect.poll(async () => ((await (await request.get(`/api/draft/${id}`)).json()) as { picks: { pick: number; playerId: string }[] }).picks.find((p) => p.pick === 6)?.playerId, { timeout: 15_000 }).toBe(top[4].player.id);
  // the bot endpoint refuses while the Yahoo tab is delivering
  expect((await request.post(`/api/draft/${id}/autopick`, { data: { untilUserTurn: true } })).status()).toBe(409);

  // snapshot goes to the debug endpoint
  await overlay(yahoo, "snapshot-btn").click();
  await expect(overlay(yahoo, "snapshot")).toContainText("Snapshot saved: draftroom-", { timeout: 15_000 });

  // collapse + persisted state doesn't break scanning
  await overlay(yahoo, "collapse").click();
  await expect(overlay(yahoo, "conn")).toBeHidden();

  // turning browser sync off unlocks the bot toggle; the userscript keeps writing but the board stops following
  await app.getByTestId("browser-toggle").uncheck(); // popover is still open
  await expect(app.getByTestId("mode-mock")).toBeEnabled();
  await expect(app.getByTestId("browser-status")).toHaveText("Browser sync: off");
});

test("userscript falls back to fetch (CORS for *.yahoo.com origins) when GM.xmlHttpRequest is unavailable", async ({ context, request }) => {
  // Chromium >= 142 gates public-site -> localhost fetches behind a "Local network access" permission prompt; grant it as a user would.
  await context.grantPermissions(["local-network-access"], { origin: "https://basketball.fantasysports.yahoo.com" });
  await newDraft(request);
  const top = await topPlayers(request);
  const app = await context.newPage();
  await app.goto("/draft");
  await app.getByTestId("browser-status").click();
  await app.getByTestId("browser-toggle").check();
  const yahoo = await context.newPage();
  await openRoom(yahoo, { gm: false });
  await addPick(yahoo, 1, top[0].player);
  await addPick(yahoo, 2, top[1].player);
  await expect(app.getByTestId("current-pick")).toHaveText("3", { timeout: 20_000 });
  await expect(overlay(yahoo, "conn")).toContainText("Connected");
});

test("CORS: preflight (incl. Private Network Access) and origin allow-list", async ({ request }) => {
  const id = await newDraft(request);
  const pre = await request.fetch(`/api/draft/${id}/external-picks`, {
    method: "OPTIONS",
    headers: { origin: "https://basketball.fantasysports.yahoo.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true" },
  });
  expect(pre.status()).toBe(204);
  expect(pre.headers()["access-control-allow-origin"]).toBe("https://basketball.fantasysports.yahoo.com");
  expect(pre.headers()["access-control-allow-private-network"]).toBe("true");
  const evil = await request.fetch(`/api/draft/${id}/external-picks`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  expect(evil.headers()["access-control-allow-origin"]).toBeUndefined();
  const get = await request.get("/api/draft/active-id", { headers: { origin: "https://sports.yahoo.com" } });
  expect(get.headers()["access-control-allow-origin"]).toBe("https://sports.yahoo.com");
  expect((await get.json()).id).toBe(id);
});
