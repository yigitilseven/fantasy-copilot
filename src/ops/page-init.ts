/**
 * Builds the script the browser worker injects (page.addInitScript) into the ONE Yahoo league page it opens:
 *  - window.__FDC_ORIGIN = internal app URL (the userscript's override hook), window.__FDC_FORCE_SYNC = true (skip the 2 h gate once),
 *  - a GM.xmlHttpRequest shim that forwards to a Node-side binding (which talks to the app over the internal network),
 *  - the built userscript itself, run on DOMContentLoaded exactly like the userscript manager would.
 * The userscript is inlined as code (no eval), so Yahoo's CSP cannot block it.
 */
export interface InitOpts {
  userscript: string;
  origin: string;
  /** name of the function exposed with page.exposeFunction */
  binding: string;
  forceSync?: boolean;
  /** window.__FDC_SYNC_FULL = true: also re-read the free-agent list even when it is fresh (manual refresh). */
  fullSync?: boolean;
}

export function buildInitScript(o: InitOpts): string {
  const head = `
(function () {
  if (window.__fdcWorkerInit) return;
  window.__fdcWorkerInit = true;
  window.__FDC_ORIGIN = ${JSON.stringify(o.origin)};
  ${o.forceSync === false ? "" : "window.__FDC_FORCE_SYNC = true;"}
  ${o.fullSync ? "window.__FDC_SYNC_FULL = true;" : ""}
  var BINDING = ${JSON.stringify(o.binding)};
  window.GM = {
    xmlHttpRequest: function (opts) {
      var fn = window[BINDING];
      if (typeof fn !== "function") { if (opts.onerror) opts.onerror(new Error("binding missing")); return {}; }
      var done = false;
      fn({ method: opts.method || "GET", url: opts.url, headers: opts.headers || {}, data: opts.data, timeout: opts.timeout || 8000 }).then(
        function (r) { if (!done) { done = true; if (opts.onload) opts.onload({ status: r.status, responseText: r.text }); } },
        function () { if (!done) { done = true; if (opts.onerror) opts.onerror(new Error("network")); } }
      );
      return { abort: function () { done = true; } };
    }
  };
  var run = function () {
`;
  const tail = `
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
`;
  return head + o.userscript + tail;
}

/** Node side of the shim: only the app's own API, only GET/POST, never anything else (the page is untrusted). */
export interface ShimRequest { method: string; url: string; headers?: Record<string, string>; data?: string; timeout?: number }

export function makeAppForwarder(appOrigin: string, f: typeof fetch = fetch) {
  const base = new URL(appOrigin);
  return async (r: ShimRequest): Promise<{ status: number; text: string }> => {
    const u = new URL(r.url);
    if (u.origin !== base.origin || !u.pathname.startsWith("/api/")) throw new Error(`blocked: ${u.origin}${u.pathname}`);
    const method = r.method.toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error(`blocked method ${method}`);
    const res = await f(u.toString(), {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? r.data : undefined,
      signal: AbortSignal.timeout(Math.min(r.timeout ?? 8000, 30_000)),
      cache: "no-store",
    });
    return { status: res.status, text: await res.text() };
  };
}
