import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

// Overlay + Players-table badges, with the Copilot API route-mocked (no server needed) on a fake Yahoo draft room.
const YAHOO_URL = "https://basketball.fantasysports.yahoo.com/nba/12345/draft";
const SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../extension/yahoo-draft-reader.user.js"), "utf8");
const FIXTURE = fs.readFileSync(path.resolve(__dirname, "../fixtures-extension/yahoo-2026-room-trimmed.html"), "utf8");
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS", "access-control-allow-headers": "content-type" };
const b = (playerId: string, name: string, nbaTeam: string, state: string, score: number, rank: number) => ({ playerId, name, nbaTeam, state, score, rank });

const REC = {
  draftId: 7, currentPick: 17, totalPicks: 156, status: "in_progress", teams: 12, userSlot: 4, onClock: true, userNextPick: 17, picksUntilUser: 0,
  strategy: { preset: "balanced", riskTolerance: 0.15, puntedCategories: [] as string[] },
  needs: ["pts", "reb", "ast", "stl", "blk", "3pm", "fg%", "ft%", "to"].map((category, i) => ({ category, weight: 1 - i * 0.1 })),
  roster: [{ pick: 4, playerId: "kat", name: "Karl-Anthony Towns", positions: ["PF", "C"], nbaTeam: "NYK" }],
  top: [{ playerId: "jm", name: "Jamal Murray", nbaTeam: "DEN", positions: ["PG"], adp: 17.2, state: "DRAFT", score: 74.4, nineCat: 3.1, rosterFit: 1.2, survival: 0.05, riskLabel: "low", reason: "Best fit for your build", status: "day-to-day", injuryNote: "Day-to-day (CBS, Oct 7)" }],
  board: [b("jm", "Jamal Murray", "DEN", "DRAFT", 74.4, 1), { ...b("at-hou", "Amen Thompson", "HOU", "WAIT", 66, 3), status: "out" }, b("at-det", "Ausar Thompson", "DET", "AVOID", 41, 60)],
  generatedAt: "2026-10-07T00:00:00Z", simMs: 40,
};

async function open(page: Page, handler: (route: Route) => Promise<void> | void) {
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => r.fulfill({ contentType: "text/html", body: FIXTURE }));
  await page.route("http://localhost:3000/**", handler);
  await page.goto(YAHOO_URL);
  await page.addScriptTag({ content: SCRIPT });
}

test("overlay shows the DRAFT pick, badges render in the players table, strategy select PATCHes", async ({ page }) => {
  const patches: unknown[] = [];
  const strategy = { ...REC.strategy };
  await open(page, async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
    if (url.endsWith("/api/draft/active-id")) return json(200, { id: 7, teams: 12 });
    if (url.includes("/recommendations")) return json(200, { ...REC, strategy });
    if (url.endsWith("/external-picks")) return json(200, { ingested: 0, draft: { currentPick: 17 } });
    if (url.endsWith("/strategy")) {
      const body = req.postDataJSON();
      patches.push(body);
      if (body.preset) strategy.preset = body.preset;
      return json(200, {});
    }
    return json(404, {});
  });

  await expect(page.locator('[data-fdc="title"]')).toHaveText("PICK 17 · YOU'RE UP");
  const hero = page.locator('[data-fdc="rec-row"][data-state="DRAFT"]');
  await expect(hero).toContainText("Jamal Murray");
  await expect(hero).toContainText("Best fit for your build");
  await expect(page.locator('[data-fdc="need"]')).toHaveCount(9);
  await expect(hero.locator('[data-fdc="status"]')).toHaveText("DTD");
  await expect(page.locator('[data-fdc-status="out"]')).toHaveText("O");
  await expect(page.locator('[data-fdc-status="day-to-day"]')).toHaveCount(0);

  const badge = page.locator('[data-fdc-badge]');
  await expect(badge.first()).toBeVisible();
  await expect(page.locator('[data-fdc-badge]', { hasText: "#1 DRAFT 74" })).toHaveCount(1);
  await expect(page.locator('[data-fdc-badge]', { hasText: "#3 WAIT 66" })).toHaveCount(1);
  await expect(page.locator('[data-fdc-badge]', { hasText: "AVOID 41" })).toHaveCount(1);
  await expect(page.locator("#feed [data-fdc-badge]")).toHaveCount(0);
  const n = await badge.count();
  await page.waitForTimeout(1200);
  expect(await badge.count()).toBe(n); // stable: no feedback loop

  await page.locator('[data-fdc="preset"]').selectOption("punt-ft");
  await expect.poll(() => patches).toEqual([{ preset: "punt-ft" }]);
  await expect(page.locator('[data-fdc="chip"]')).toHaveText("Punt FT%");
});

test("shows 'Copilot app not running' when the API is down", async ({ page }) => {
  await open(page, (route) => route.abort("connectionrefused"));
  await expect(page.locator('[data-fdc="recerr"]')).toContainText("Copilot app not running (pnpm dev)");
});
