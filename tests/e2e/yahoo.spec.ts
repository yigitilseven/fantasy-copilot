import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface PlayersRes { player: { id: string; name: string }; market: { rank: number } }

const LEAGUE = { leagueKey: "466.l.12345", name: "Mock Yahoo League", season: 2026, numTeams: 14, draftStatus: "predraft", scoringType: "head", userTeamKey: "466.l.12345.t.13", userSlot: 13 };
const currentPick = (page: Page) => page.getByTestId("current-pick");

async function newDraft(request: APIRequestContext): Promise<number> {
  const res = await request.post("/api/draft", { data: {} });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}
async function topPlayers(request: APIRequestContext): Promise<PlayersRes[]> {
  const players = (await (await request.get("/api/players")).json()) as PlayersRes[];
  return players.sort((a, b) => a.market.rank - b.market.rank);
}

async function mockYahoo(page: Page, opts: { authenticated: boolean; sync?: (draftId: number) => Promise<{ status: number; body: unknown }> }) {
  await page.route("**/api/yahoo/status", (r) =>
    r.fulfill({ json: { authenticated: opts.authenticated, credentialsConfigured: opts.authenticated, tokensPresent: opts.authenticated, hasRefreshToken: opts.authenticated } }),
  );
  await page.route("**/api/yahoo/leagues", (r) =>
    opts.authenticated ? r.fulfill({ json: { leagues: [LEAGUE] } }) : r.fulfill({ status: 502, json: { error: "no auth", code: "AUTH" } }),
  );
  if (opts.sync) {
    const sync = opts.sync;
    await page.route("**/api/yahoo/sync", async (r) => {
      const { draftId } = r.request().postDataJSON() as { draftId: number };
      const { status, body } = await sync(draftId);
      await r.fulfill({ status, json: body });
    });
  }
}

test("live sync: picks made 'on Yahoo' appear on the board with no user input; bots disabled", async ({ page, request }) => {
  const id = await newDraft(request);
  const top = await topPlayers(request);
  let applied = 0;
  let calls = 0;
  await mockYahoo(page, {
    authenticated: true,
    sync: async (draftId) => {
      calls++;
      // Each poll "reveals" 2 new Yahoo picks (up to 6) by applying them through the real local pick API as source yahoo.
      let draft: unknown = null;
      let ingested = 0;
      while (applied < 6 && ingested < 2) {
        const res = await page.request.post(`/api/draft/${draftId}/pick`, { data: { playerId: top[applied].player.id, source: "yahoo" } });
        draft = await res.json();
        applied++;
        ingested++;
      }
      if (!draft) draft = await (await page.request.get(`/api/draft/${draftId}`)).json();
      return { status: 200, body: { ingested, draft, unmapped: [], mismatches: [], yahooPicks: applied, stoppedReason: null } };
    },
  });
  await page.addInitScript(() => localStorage.setItem("fdc:botSpeed", "slow"));

  await page.goto("/draft");
  await expect(currentPick(page)).toHaveText("1");
  await expect(page.getByTestId("yahoo-status")).toContainText("Yahoo: connected");

  // enter mock mode first, then turn on live sync: it must flip to manual and lock bots out
  await page.getByTestId("mode-mock").click();
  await page.getByTestId("yahoo-status").click();
  await expect(page.getByTestId("yahoo-league-select")).toHaveValue(LEAGUE.leagueKey); // single league auto-selected
  await page.getByTestId("yahoo-live-toggle").check();
  await expect(page.getByTestId("mode-manual")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("mode-mock")).toBeDisabled();
  await expect(page.getByTestId("new-mock-button")).toBeDisabled();

  // no further input: board advances 1 -> 3 -> 5 -> 7 by itself
  await expect(currentPick(page)).toHaveText("7", { timeout: 15_000 });
  await expect(page.getByTestId("pick-log-item")).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(page.locator(`[data-player-id="${top[i].player.id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("yahoo-status")).toContainText("live");
  await expect(page.getByTestId("yahoo-last-sync")).toContainText(/synced \d+s ago/);
  await expect(page.getByTestId("yahoo-last-sync")).toContainText("6 picks pulled");
  expect(calls).toBeGreaterThanOrEqual(3);

  // turning it off stops polling and restores the bot toggle
  await page.getByTestId("yahoo-live-toggle").uncheck();
  const before = calls;
  await page.waitForTimeout(3500);
  expect(calls).toBeLessThanOrEqual(before + 1);
  await expect(page.getByTestId("mode-mock")).toBeEnabled();
  expect((await (await request.get(`/api/draft/${id}`)).json()).picks.length).toBe(6);
});

test("live sync: unmapped Yahoo player offers a manual fix, then sync continues", async ({ page, request }) => {
  await newDraft(request);
  const top = await topPlayers(request);
  let fixed = false;
  await mockYahoo(page, {
    authenticated: true,
    sync: async (draftId) => {
      const draft = await (await page.request.get(`/api/draft/${draftId}`)).json();
      if (draft.picks.length === 0 && !fixed)
        return { status: 502, body: { error: "unmapped", code: "UNMAPPED_PLAYER", ingested: 0, draft, unmapped: [{ pick: 1, yahooPlayerKey: "466.p.99999", name: "Mystery Rookie" }], mismatches: [] } };
      fixed = true;
      return { status: 200, body: { ingested: 0, draft, unmapped: [], mismatches: [], yahooPicks: draft.picks.length, stoppedReason: null } };
    },
  });
  await page.goto("/draft");
  await page.getByTestId("yahoo-status").click();
  await page.getByTestId("yahoo-live-toggle").check();
  await expect(page.getByTestId("yahoo-unmapped-name")).toHaveText("Mystery Rookie");
  // the board stays usable meanwhile
  await expect(page.getByTestId("player-row").first()).toBeVisible();

  const target = top[3].player;
  await page.getByTestId("yahoo-unmapped-search").fill(target.name.slice(0, 6));
  await page.getByTestId("yahoo-unmapped-option").filter({ hasText: target.name }).click();
  await expect(currentPick(page)).toHaveText("2");
  await expect(page.getByTestId("yahoo-unmapped")).toHaveCount(0);
  await expect(page.locator(`[data-player-id="${target.id}"]`)).toHaveCount(0);
});

test("live sync: Yahoo delay shows a non-blocking notice and manual entry still works", async ({ page, request }) => {
  test.setTimeout(60_000);
  await newDraft(request);
  let n = 0;
  await mockYahoo(page, {
    authenticated: true,
    sync: async (draftId) => {
      const draft = await (await page.request.get(`/api/draft/${draftId}`)).json();
      if (n++ === 0) return { status: 502, body: { error: "Yahoo rate limit", code: "RATE_LIMIT", manualModeAvailable: true } };
      return { status: 200, body: { ingested: 0, draft, unmapped: [], mismatches: [], yahooPicks: 0, stoppedReason: null } };
    },
  });
  await page.goto("/draft");
  await page.getByTestId("yahoo-status").click();
  await page.getByTestId("yahoo-live-toggle").check();
  await expect(page.getByTestId("yahoo-banner")).toContainText("Yahoo delayed — manual entry still works");
  await page.getByTestId("player-row").first().getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("2");
  await expect(page.getByTestId("yahoo-banner")).toHaveCount(0, { timeout: 15_000 }); // retried after 10s and recovered
});

test("not connected: status shown with hint, manual drafting unaffected", async ({ page, request }) => {
  await newDraft(request);
  await mockYahoo(page, { authenticated: false });
  await page.goto("/draft");
  const chip = page.getByTestId("yahoo-status");
  await expect(chip).toHaveText("Yahoo: not connected");
  await expect(chip).toHaveAttribute("title", "run pnpm yahoo:auth");
  await expect(currentPick(page)).toHaveText("1");
  await page.getByTestId("player-row").first().getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("2");
  await expect(page.getByTestId("mode-mock")).toBeEnabled();
});
