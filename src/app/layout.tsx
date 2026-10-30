import type { Metadata, Viewport } from "next";
import ServiceWorker from "./service-worker";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin", "latin-ext"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Fantasy Copilot",
  description: "Personal Yahoo Fantasy Basketball command center: lineup, moves, matchup and league analysis",
  applicationName: "Fantasy Copilot",
  // iOS "Add to Home Screen": standalone window (required for Web Push on iPhone), own title, status bar, icon.
  appleWebApp: { capable: true, title: "Copilot", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  // Next 16 emits only the standard mobile-web-app-capable tag; older iOS versions read the apple- one.
  other: { "apple-mobile-web-app-capable": "yes" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#090c11" },
    { media: "(prefers-color-scheme: light)", color: "#f1f4f8" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Applies the theme chosen in Settings before the first paint (no flash). "system" = no attribute.
const THEME_INIT = `try{var t=localStorage.getItem("fc:theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <ServiceWorker />
        {children}
      </body>
    </html>
  );
}
