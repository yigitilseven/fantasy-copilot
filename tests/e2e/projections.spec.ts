import { expect, test } from "@playwright/test";
import { newAppPage, openRoom, room, top } from "./fake-room";

test("Capture projections scrolls the lazy list, posts it, the chip shows the count and the player's line changes", async ({ page, request, browser }) => {
  const before = await top(request);
  const star = before[0];
  const beforePts = star.projection.pts;
  await request.post("/api/draft", { data: {} });
  await openRoom(page, room(before, 70));

  await expect(page.locator('[data-fdc="capture-btn"]')).toBeVisible();
  await page.locator('[data-fdc="capture-btn"]').click();
  await expect(page.locator('[data-fdc="capture-status"]')).toContainText("Captured 70 players", { timeout: 30_000 });
  await expect(page.locator('[data-fdc="capture-status"]')).toContainText("sent to the app");
  expect(await page.evaluate(() => document.getElementById("scroller")!.scrollTop)).toBe(0); // scrolled back to the top

  const st = await (await request.get("/api/projections/yahoo/status")).json();
  expect(st).toMatchObject({ count: 70, matched: 70, usable: 70 });

  const after = (await top(request)).find((p) => p.player.id === star.player.id)!;
  expect(after.projection.projectionSource).toBe("yahoo-2026-27");
  expect(after.projection.games).toBe(70);
  expect(after.projection.pts).toBeCloseTo(3500 / 70, 5);
  expect(after.projection.pts).not.toBeCloseTo(beforePts, 1);

  const app = await newAppPage(browser);
  const chip = app.getByTestId("projections-status");
  await expect(chip).toHaveAttribute("data-source", "yahoo");
  await expect(chip).toContainText("Yahoo 2026-27 (70 players");
  await app.context().close();
});

test("Capture refuses another stat view and sends nothing", async ({ page, request }) => {
  const before = await top(request);
  const countBefore = (await (await request.get("/api/projections/yahoo/status")).json()).count;
  // starts on the average view (the proj view would be captured automatically)
  await openRoom(page, room(before, 40).replace('<option value="average">', '<option value="average" selected>'));
  await page.locator("#stat-mode-filter").selectOption("average");
  await page.locator('[data-fdc="capture-btn"]').click();
  await expect(page.locator('[data-fdc="capture-status"]')).toHaveText("Select '2026-27 Proj Stats' in Yahoo's Players tab first");
  expect((await (await request.get("/api/projections/yahoo/status")).json()).count).toBe(countBefore);
});

test("alert when Yahoo's side panel leaves PICKS: banner on the Yahoo page and in the app, cleared when the feed is back", async ({ page, request, browser }) => {
  const players = await top(request);
  const d = await request.post("/api/draft", { data: {} });
  expect(d.status()).toBe(201);
  await openRoom(page, room(players, 40));
  const app = await newAppPage(browser);

  await expect(page.locator('[data-fdc="alert-banner"]')).toHaveCount(0);
  await expect(app.getByTestId("yahoo-panel-alert")).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { showPanel: (w: string) => void }).showPanel("queue"));
  await expect(page.locator('[data-fdc="panel-note"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-fdc="alert-banner"]')).toContainText("switch Yahoo's side panel to PICKS", { timeout: 15_000 });
  await expect.poll(() => page.title()).toMatch(/^⚠ /);
  await expect(app.getByTestId("yahoo-panel-alert")).toContainText("Picks panel hidden", { timeout: 15_000 });

  await page.evaluate(() => (window as unknown as { showPanel: (w: string) => void }).showPanel("picks"));
  await expect(page.locator('[data-fdc="alert-banner"]')).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => page.title()).not.toMatch(/^⚠ /);
  await expect(app.getByTestId("yahoo-panel-alert")).toHaveCount(0, { timeout: 15_000 });
  await app.context().close();
});
