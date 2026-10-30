import fs from "node:fs";
import path from "node:path";
import { expect, test, type Route } from "@playwright/test";
import { openRoom, room, top } from "./fake-room";

const note = '[data-fdc="proj-note"]';

test("auto-capture: the proj view in a never-captured draft room is captured without clicking, and not again after a reload", async ({ page, request }) => {
  const players = await top(request);
  expect((await request.post("/api/draft", { data: {} })).status()).toBe(201);
// (file name sorts last: the captures below change the shared e2e projections)
  await openRoom(page, room(players, 70));

  await expect(page.locator('[data-fdc="capture-status"]')).toContainText("Captured 70 players", { timeout: 30_000 });
  await expect(page.locator(note)).toContainText("Projections captured for this draft ✓ (70 players", { timeout: 10_000 });
  await expect(page.locator(note)).toHaveAttribute("data-kind", "done");
  const st = await (await request.get("/api/projections/yahoo/status")).json();
  expect(st).toMatchObject({ usable: 70 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fdc:projCapture")!).draftRoomKey)).toBe("12345");

  // same room, within 12 h: nothing is captured again
  await page.reload();
  await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, "../../extension/yahoo-draft-reader.user.js"), "utf8") });
  await expect(page.locator(note)).toHaveAttribute("data-kind", "done", { timeout: 10_000 });
  await page.waitForTimeout(2500);
  await expect(page.locator('[data-fdc="capture-status"]')).not.toContainText("Captured");
});

test("pre-draft hint while the proj view is not selected; selecting it captures automatically", async ({ page, request }) => {
  const players = await top(request);
  await request.post("/api/draft", { data: {} });
  await openRoom(page, room(players, 40).replace('<option value="average">', '<option value="average" selected>'));
  await expect(page.locator(note)).toHaveText("Pre-draft: select '2026-27 Proj Stats' in Yahoo's Players tab to refresh projections", { timeout: 10_000 });
  await expect(page.locator(note)).toHaveAttribute("data-kind", "hint");
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-fdc="capture-status"]')).not.toContainText("Captured");

  await page.locator("#stat-mode-filter").selectOption("projected");
  await expect(page.locator('[data-fdc="capture-status"]')).toContainText("Captured 40 players", { timeout: 30_000 });
  await expect(page.locator(note)).toHaveAttribute("data-kind", "done", { timeout: 10_000 });
});

test("auto-capture waits while the user is on the clock and runs after the pick", async ({ page, request }) => {
  const players = await top(request);
  await request.post("/api/draft", { data: {} });
  await openRoom(page, room(players, 40).replace("Drafter ZZ's Pick • Round 1, Pick 3", "Your Pick • Round 1, Pick 3"));
  await expect(page.locator(note)).toHaveAttribute("data-kind", "defer", { timeout: 10_000 });
  await page.waitForTimeout(2000);
  await expect(page.locator('[data-fdc="capture-status"]')).not.toContainText("Captured");

  await page.evaluate(() => {
    document.getElementById("clock")!.textContent = "Drafter ZZ's Pick • Round 1, Pick 4";
  });
  await expect(page.locator('[data-fdc="capture-status"]')).toContainText("Captured 40 players", { timeout: 30_000 });
});

test("pre-draft checklist: rows flip from ✗ to ✓, news refresh shows a spinner, panel hides after pick 1 and the chip re-opens it", async ({ page, request }) => {
  const draft = await (await request.post("/api/draft", { data: {} })).json();
  const players = await top(request);

  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const world = { newsAt: old as string, proj: { usable: 0, capturedAt: null as string | null }, heartbeat: null as null | { panel: string } };
  const json = (route: Route, body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/news/status", (r) => json(r, { lastSuccessAt: world.newsAt, lastAttemptAt: world.newsAt, stale: true, refreshing: false, sources: [] }));
  await page.route("**/api/news/refresh", async (r) => {
    await new Promise((res) => setTimeout(res, 1200));
    world.newsAt = new Date().toISOString();
    await json(r, { sources: [] });
  });
  await page.route("**/api/projections/yahoo/status", (r) => json(r, { count: 0, matched: 0, created: 0, season: "2026-27", ...world.proj }));
  await page.route(`**/api/draft/${draft.id}/external-picks`, async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const real = await (await r.fetch()).json();
    await json(r, { ...real, status: world.heartbeat ? { receivedAt: Date.now(), received: 0, highestPick: 0, totalIngested: 0, unmapped: null, mismatches: [], stoppedReason: null, conflict: null, pageVisible: true, ...world.heartbeat } : null });
  });

  await page.goto("/draft");
  const row = (k: string) => page.getByTestId(`predraft-${k}`);
  await expect(page.getByTestId("predraft-panel")).toBeVisible(); // pick 1
  await expect(page.getByTestId("predraft-chip")).toContainText("✗");
  for (const k of ["news", "projections", "yahoo-tab", "browser-sync"]) await expect(row(k)).toHaveAttribute("data-state", "bad", { timeout: 10_000 });
  await expect(row("projections")).toContainText("2026-27 Proj Stats");
  await expect(row("yahoo-tab")).toContainText("reload it once");
  await expect(row("setup")).toHaveAttribute("data-state", "ok");

  // news: refresh button with spinner
  await page.getByTestId("predraft-news-refresh").click();
  await expect(page.getByTestId("predraft-spinner")).toBeVisible();
  await expect(row("news")).toHaveAttribute("data-state", "ok", { timeout: 10_000 });

  // projections captured elsewhere
  world.proj = { usable: 733, capturedAt: new Date().toISOString() };
  await expect(row("projections")).toHaveAttribute("data-state", "ok", { timeout: 8000 });
  await expect(row("projections")).toContainText("733 players");

  // Yahoo tab heartbeat with the Picks panel hidden, then fixed
  world.heartbeat = { panel: "hidden" };
  await expect(row("yahoo-tab")).toHaveAttribute("data-state", "ok", { timeout: 8000 });
  await expect(row("picks-panel")).toHaveAttribute("data-state", "bad");
  await expect(row("picks-panel")).toContainText("PICKS");
  world.heartbeat = { panel: "picks" };
  await expect(row("picks-panel")).toHaveAttribute("data-state", "ok", { timeout: 8000 });

  // browser sync
  await expect(page.getByTestId("predraft-chip")).toContainText("✗");
  await page.getByTestId("predraft-sync-on").click();
  await expect(row("browser-sync")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("predraft-chip")).toHaveText("Pre-draft ✓");

  // pick 1 made: the panel goes away, the chip stays and re-opens it
  const r1 = await request.post(`/api/draft/${draft.id}/pick`, { data: { playerId: players[0].player.id } });
  expect(r1.ok()).toBeTruthy();
  await expect(page.getByTestId("current-pick")).toHaveText("2", { timeout: 10_000 });
  await expect(page.getByTestId("predraft-panel")).toHaveCount(0);
  await expect(page.getByTestId("predraft-chip")).toBeVisible();
  await page.getByTestId("predraft-chip").click();
  await expect(page.getByTestId("predraft-panel")).toBeVisible();
  await page.getByTestId("predraft-chip").click();
  await expect(page.getByTestId("predraft-panel")).toHaveCount(0);
});
