import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `output: "standalone"` only changes `next build` (a self-contained server in .next/standalone for the Docker image, see deploy/);
  // `next dev` and `next start` behave as before.
  output: "standalone",
  // The SQLite driver is a native module: keep it out of the bundle (the standalone tracer copies it).
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
