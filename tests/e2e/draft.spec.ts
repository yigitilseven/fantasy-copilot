import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface PlayersRes { player: { id: string }; market: { rank: number } }

/** Fresh draft; optionally fast-forward `n` picks via the API using top-ranked players. */
async function newDraft(request: APIRequestContext, n = 0): Promise<number> {
  const res = await request.post("/api/draft", { data: {} });
  expect(res.status()).toBe(201);
  const draft = await res.json();
  if (n > 0) {
    const players = (await (await request.get("/api/players")).json()) as PlayersRes[];
    players.sort((a, b) => a.market.rank - b.market.rank);
    for (let i = 0; i < n; i++) {
      const r = await request.post(`/api/draft/${draft.id}/pick`, { data: { playerId: players[i].player.id } });
      expect(r.ok()).toBeTruthy();
    }
  }
  return draft.id;
}

const currentPick = (page: Page) => page.getByTestId("current-pick");
const rows = (page: Page) => page.getByTestId("player-row");

test("fresh draft starts at pick 1 and a UI pick advances it", async ({ page, request }) => {
  await newDraft(request);
  await page.goto("/draft");
  await expect(currentPick(page)).toHaveText("1");
  await expect(rows(page).first()).toBeVisible();
  const id = await rows(page).first().getAttribute("data-player-id");
  await rows(page).first().getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("2");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(0);
});

test("pick 13: YOUR PICK, DRAFT state, draft → 14/next 16, undo, reload", async ({ page, request }) => {
  await newDraft(request, 12);
  await page.goto("/draft");
  await expect(currentPick(page)).toHaveText("13");
  await expect(page.getByTestId("on-clock")).toHaveText("YOUR PICK");

  const draftRow = page.locator('[data-testid="player-row"][data-state="DRAFT"]').first();
  await expect(draftRow).toBeVisible();
  await expect(page.getByTestId("recommendation")).toContainText("DRAFT");
  const id = await draftRow.getAttribute("data-player-id");

  await draftRow.getByTestId("draft-button").click();
  await expect(currentPick(page)).toHaveText("14");
  await expect(page.getByTestId("next-pick")).toHaveText("16");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("roster-list").getByTestId("roster-item").first()).not.toContainText("—");

  // reload restores from SQLite
  await page.reload();
  await expect(currentPick(page)).toHaveText("14");
  await expect(page.getByTestId("next-pick")).toHaveText("16");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(0);

  // undo restores pick 13 and the player
  await page.getByTestId("undo-button").click();
  await expect(currentPick(page)).toHaveText("13");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(1);
});

test("keyboard: arrows move selection, Enter drafts selected, U undoes", async ({ page, request }) => {
  await newDraft(request, 12);
  await page.goto("/draft");
  await expect(currentPick(page)).toHaveText("13");
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).first()).toHaveAttribute("data-selected", "true");

  const id = await rows(page).first().getAttribute("data-player-id");
  await page.keyboard.press("Enter");
  await expect(currentPick(page)).toHaveText("14");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(0);

  await page.keyboard.press("u");
  await expect(currentPick(page)).toHaveText("13");
  await expect(page.locator(`[data-player-id="${id}"]`)).toHaveCount(1);

  // S focuses search; typing there does not trigger shortcuts
  await page.keyboard.press("s");
  await expect(page.getByTestId("search")).toBeFocused();
  await page.keyboard.type("u");
  await expect(currentPick(page)).toHaveText("13");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search")).not.toBeFocused();
});
