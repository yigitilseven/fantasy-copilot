import { expect, test } from "@playwright/test";

test("strategy selector: persists, greys out punted category, syncs a change made through the API (overlay)", async ({ page, request }) => {
  const draft = await (await request.post("/api/draft", { data: {} })).json();
  await page.goto("/draft");
  await expect(page.getByTestId("player-row").first()).toBeVisible();

  await page.getByTestId("strategy-preset").selectOption("punt-ft");
  await expect(page.getByTestId("cat-FT%")).toHaveAttribute("data-punted", "true");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.preset).toBe("punt-ft");
  const rec = await (await request.get(`/api/draft/${draft.id}/recommendations?limit=5`)).json();
  expect(rec.strategy.puntedCategories).toEqual(["FT%"]);
  expect(rec.top).toHaveLength(5);

  await page.getByTestId("strategy-risk").selectOption("aggressive");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.riskTolerance).toBe(0.05);

  // changed "from the overlay": the open app adopts it within a few seconds
  const res = await request.patch(`/api/draft/${draft.id}/strategy`, { data: { preset: "punt-to" } });
  expect(res.ok()).toBeTruthy();
  await expect(page.getByTestId("strategy-preset")).toHaveValue("punt-to", { timeout: 8000 });
  await expect(page.getByTestId("cat-TO")).toHaveAttribute("data-punted", "true");
  await expect(page.getByTestId("cat-FT%")).not.toHaveAttribute("data-punted", "true");

  await page.reload();
  await expect(page.getByTestId("strategy-preset")).toHaveValue("punt-to");
});

test("projection mix: Auto by default, a fixed mix persists on the draft and reaches the recommendations; Team outlook opens", async ({ page, request }) => {
  const draft = await (await request.post("/api/draft", { data: {} })).json();
  await page.goto("/draft");
  await expect(page.getByTestId("player-row").first()).toBeVisible();
  await expect(page.getByTestId("strategy-projection-mix")).toHaveValue("auto");
  await expect(page.getByTestId("strategy-robust")).toHaveValue("auto");
  expect((await (await request.get(`/api/draft/${draft.id}/recommendations?limit=3`)).json()).projection).toMatchObject({ mode: "auto", robustnessMode: "auto" });

  await page.getByTestId("strategy-projection-mix").selectOption("0.8");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.projectionWeight).toBe(0.8);
  const rec = (await (await request.get(`/api/draft/${draft.id}/recommendations?limit=3`)).json()).projection;
  expect(rec).toMatchObject({ mode: "fixed", weight: 0.8 });

  await page.reload();
  await expect(page.getByTestId("strategy-projection-mix")).toHaveValue("0.8");

  await page.getByTestId("strategy-robust").selectOption("never");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.robustnessMode).toBe("never");
  await page.getByTestId("strategy-projection-mix").selectOption("auto");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.projectionMode).toBe("auto");

  await page.getByTestId("outlook-button").click();
  await expect(page.getByTestId("team-outlook-popover")).toBeVisible();
  await expect(page.getByTestId("outlook-sweep")).toBeVisible();
  await expect(page.getByTestId("outlook-auto")).toBeVisible();
  const ev = await (await request.get(`/api/draft/${draft.id}/evaluation?view=outlook`)).json();
  expect(ev.sweep).toHaveLength(6);
  expect(ev.views).toHaveProperty("auto");
});
