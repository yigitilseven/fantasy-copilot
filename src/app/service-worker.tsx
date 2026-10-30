"use client";

import { useEffect } from "react";

/** Registers /sw.js (push + notification taps only; it caches nothing). */
export default function ServiceWorker() {
  useEffect(() => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}
