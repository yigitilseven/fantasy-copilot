import { expect, test } from "@playwright/test";

test("status pill, news icon + headline link in the detail panel, and the news chip", async ({ page, request }) => {
  expect((await request.post("/api/draft", { data: {} })).status()).toBe(201);
  let id = "";
  await page.route("**/api/players", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as { player: { id: string }; market: { rank: number }; risk: Record<string, unknown> }[];
    j.sort((a, b) => a.market.rank - b.market.rank);
    id = j[0].player.id;
    j[0].risk = {
      ...j[0].risk, currentStatus: "out", injuryNote: "Knee", estReturn: "2027-01-02", statusSource: "ESPN", statusUpdatedAt: "2026-10-05T00:00:00Z", gamesMissed: 36,
      latestNews: [{ title: "Test headline about the star", link: "https://example.com/story", source: "ESPN", publishedAt: "2026-10-06T00:00:00Z" }],
    };
    await route.fulfill({ response: res, json: j });
  });
  await page.route("**/api/news/status", (route) =>
    route.fulfill({ json: { lastSuccessAt: new Date(Date.now() - 2 * 3600_000).toISOString(), lastAttemptAt: null, stale: false, refreshing: false, sources: [{ id: "cbs-injuries", ok: false, lastError: "HTTP 500", lastSuccessAt: null }, { id: "espn-injuries", ok: true, lastError: null, lastSuccessAt: null }] } }),
  );
  await page.goto("/draft");
  await expect.poll(() => id).not.toBe("");
  // The injected player (#1 by rank, now out ~36 games) — target him by id: ranking no longer sinks "out" players to the bottom.
  const row = page.locator(`[data-testid="player-row"][data-player-id="${id}"]`);
  await expect(row).toBeVisible();
  const pill = row.getByTestId("status-pill");
  await expect(pill).toHaveText("O");
  await expect(pill).toHaveAttribute("title", /Out — est\. return Jan 2 \(ESPN, Oct 5\)/);
  await expect(row.getByTestId("news-icon")).toHaveAttribute("title", "Test headline about the star");
  await row.click();
  const link = page.getByTestId("latest-news");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", "https://example.com/story");
  await expect(page.getByTestId("injury-line")).toContainText("Out — est. return Jan 2");
  expect(id).not.toBe("");
  await expect(page.getByTestId("news-status")).toContainText("News: updated 2h ago");
  await expect(page.getByTestId("news-status")).toHaveAttribute("title", /cbs-injuries: HTTP 500/);
});
