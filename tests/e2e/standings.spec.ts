import { expect, test } from "@playwright/test";

test("standings: weekly outlook + projected finish + core chips, Roto in the detail panel, objective selector (classic hides them)", async ({ page, request }) => {
  const draft = await (await request.post("/api/draft", { data: {} })).json();
  await page.goto("/draft");
  await expect(page.getByTestId("player-row").first()).toBeVisible();

  await expect(page.getByTestId("weekly-outlook")).toHaveText(/^Weekly outlook: wins ~\d\.\d cats · beats \d+\/13 teams$/, { timeout: 15000 });
  await expect(page.getByTestId("projected-finish")).toHaveText(/^Projected finish: Proj #\d+ · Total #\d+ · Avg #\d+$/);
  await expect(page.getByTestId("core-cats").locator("[data-core]")).toHaveCount(9);
  await expect(page.getByTestId("strategy-objective")).toHaveValue("h2h");
  await expect(page.getByTestId("standings-detail")).toContainText("Weekly win odds");
  await expect(page.getByTestId("roto-score")).toBeVisible();

  const rec = await (await request.get(`/api/draft/${draft.id}/recommendations?limit=5`)).json();
  expect(rec.objective).toBe("h2h");
  expect(rec.standings.weeklyLine).toMatch(/^Weekly outlook/);
  expect(rec.top[0].reason).toMatch(/weekly win odds|Little change|Costs weekly/);

  await page.getByTestId("strategy-objective").selectOption("classic");
  await expect.poll(async () => (await (await request.get(`/api/draft/${draft.id}`)).json()).strategy?.objective).toBe("classic");
  await expect(page.getByTestId("roto-score")).toHaveCount(0, { timeout: 15000 });
  const classic = await (await request.get(`/api/draft/${draft.id}/recommendations?limit=5`)).json();
  expect(classic.standings).toBeNull();
  expect(classic.top.every((t: { roto: number | null }) => t.roto === null)).toBe(true);
});
