/** Shape of a push notification as the service worker receives it. iOS shows roughly 4 lines, so body is kept short. */
export interface PushPayload { title: string; body: string; url: string; tag?: string }

export const PUSH_TITLE_MAX = 60;
export const PUSH_BODY_MAX = 170;

const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const at = t.lastIndexOf(" ", max - 1);
  return t.slice(0, at > max * 0.6 ? at : max - 1).trimEnd() + "…";
};

/** Only same-site paths or https links reach the service worker (it opens them on tap). */
export function safeUrl(u: string | undefined): string {
  if (!u) return "/today";
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  try {
    return new URL(u).protocol === "https:" ? u : "/today";
  } catch {
    return "/today";
  }
}

export function formatPushPayload(p: { title?: string; body: string; url?: string; tag?: string }): PushPayload {
  return { title: cut(p.title || "Fantasy Copilot", PUSH_TITLE_MAX), body: cut(p.body, PUSH_BODY_MAX), url: safeUrl(p.url), ...(p.tag ? { tag: p.tag.slice(0, 64) } : {}) };
}
