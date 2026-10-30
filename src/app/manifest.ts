import type { MetadataRoute } from "next";

/** Installable PWA (iPhone: Share > Add to Home Screen). Opens on Today. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fantasy Copilot",
    short_name: "Copilot",
    description: "Fantasy basketball: daily brief, moves, matchup and league analysis",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#090c11",
    theme_color: "#090c11",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
