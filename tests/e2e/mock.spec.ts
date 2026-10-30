import { expect, test, type Page } from "@playwright/test";

const currentPick = (page: Page) => page.getByTestId("current-pick");

/** 1-based overall picks for a slot in a snake draft. */
function userPicks(teams: number, slot: number, rounds: number): number[] {
  return Array.from({ length: rounds }, (_, i) => {
    const r = i + 1;
    return r % 2 === 1 ? (r - 1) * teams + slot : r * teams - slot + 1;
  });
}

test("mock draft vs bots: slot 13, full draft, summary", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("fdc:botSpeed", "instant"));
  await page.goto("/draft");
  await expect(page.getByTestId("player-row").first()).toBeVisible();

  await page.getByTestId("new-mock-button").click();
  await page.getByTestId("mock-userSlot").fill("13");
  await page.getByTestId("mock-teams").fill("14");
  await page.getByTestId("mock-rounds").fill("13");
  await page.getByTestId("mock-start").click();

  // bots auto-pick to 13
  await expect(currentPick(page)).toHaveText("13");
  await expect(page.getByTestId("on-clock")).toHaveText("YOUR PICK");
  await expect(page.getByTestId("pick-log-item")).toHaveCount(12);

  const draftRow = page.locator('[data-testid="player-row"][data-state="DRAFT"]').first();
  await expect(draftRow).toBeVisible();
  await draftRow.getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("16");
  await expect(page.getByTestId("on-clock")).toHaveText("YOUR PICK");
  await expect(page.getByTestId("my-team")).toHaveText("1/13");

  // undo in mock mode rolls back to our previous pick (bots paused) ...
  await page.getByTestId("undo-button").click();
  await expect(currentPick(page)).toHaveText("13");
  await expect(page.getByTestId("my-team")).toHaveText("0/13");
  await expect(page.getByTestId("on-clock")).toHaveText("YOUR PICK");

  // ... then draft again and play the rest with Enter on the selected top row
  const mine = userPicks(14, 13, 13);
  for (let i = 0; i < mine.length; i++) {
    await expect(currentPick(page)).toHaveText(String(mine[i]));
    await expect(page.getByTestId("on-clock")).toHaveText("YOUR PICK");
    await expect(page.getByTestId("player-row").first()).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("my-team")).toHaveText(`${i + 1}/13`);
  }

  await expect(page.getByTestId("draft-summary")).toBeVisible();
  await expect(page.getByTestId("summary-roster-item")).toHaveCount(13);
  await expect(page.getByTestId("h2h-row")).toHaveCount(13);
  await expect(page.getByTestId("rank-PTS")).toBeVisible();
  await expect(page.getByTestId("win-rate")).toContainText("%");
});

test("manual mode never auto-picks; custom slot/teams reflected", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("fdc:botSpeed", "instant"));
  await page.goto("/draft");
  await page.getByTestId("new-mock-button").click();
  await page.getByTestId("mock-userSlot").fill("3");
  await page.getByTestId("mock-teams").fill("8");
  await page.getByTestId("mock-rounds").fill("5");
  await page.getByTestId("mock-start").click();
  await expect(currentPick(page)).toHaveText("3");
  await expect(page.getByTestId("my-team")).toHaveText("0/5");
  await page.getByTestId("mode-manual").click();
  await page.reload();
  await expect(page.getByTestId("mode-manual")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("player-row").first().getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("4");
  await page.waitForTimeout(500);
  await expect(currentPick(page)).toHaveText("4");
  // Sim to my pick works in manual mode: picks 4..6 then user's 3rd... next user pick is 14
  await page.getByTestId("sim-to-pick").click();
  await expect(currentPick(page)).toHaveText("14");
});
