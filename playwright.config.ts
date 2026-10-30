import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Evaluated before the webServer starts: guarantees a fresh e2e database.
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(path.resolve(__dirname, `data/e2e.sqlite${suffix}`), { force: true });
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: { baseURL: "http://localhost:3100", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm db:seed && pnpm dev --port 3100",
    url: "http://localhost:3100/api/players",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DB_FILE_NAME: "./data/e2e.sqlite", NEWS_AUTO_REFRESH: "0" },
  },
});
