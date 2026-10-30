import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // a fixed NBA-stats cache (one fake player) instead of the local data/cache: same results on every machine and in CI
    env: { STATS_CACHE_DIR: path.resolve(__dirname, "tests/fixtures-stats-cache") },
  },
});
