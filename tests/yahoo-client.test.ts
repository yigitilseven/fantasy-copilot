import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUrl, createYahooGet } from "@/integrations/yahoo/client";
import { getYahooConfig } from "@/integrations/yahoo/config";
import { YahooError } from "@/integrations/yahoo/errors";
import { buildAuthUrl, exchangeCode, loadTokens, refreshIfNeeded, saveTokens, tokenStatus } from "@/integrations/yahoo/oauth";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => {};

function scripted(...responses: (Response | Error)[]) {
  const calls: { url: string; auth: string | null }[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("yahooGet", () => {
  it("builds urls with format=json and keeps matrix params", () => {
    expect(buildUrl("B", "game/nba")).toBe("B/game/nba?format=json");
    expect(buildUrl("B", "/game/466/players;start=0;count=25")).toBe("B/game/466/players;start=0;count=25?format=json");
  });

  it("sends a bearer token and returns parsed JSON", async () => {
    const s = scripted(json({ ok: 1 }));
    const get = createYahooGet({ fetchFn: s.fetchFn, getToken: async () => "T1", sleep: noSleep });
    expect(await get("game/nba")).toEqual({ ok: 1 });
    expect(s.calls[0].auth).toBe("Bearer T1");
  });

  it("refreshes once on 401 then succeeds; second 401 is AUTH", async () => {
    const s = scripted(json({}, 401), json({ ok: 1 }));
    let refreshes = 0;
    const deps = { fetchFn: s.fetchFn, getToken: async () => "old", refreshToken: async () => (refreshes++, "new"), sleep: noSleep };
    expect(await createYahooGet(deps)("x")).toEqual({ ok: 1 });
    expect(refreshes).toBe(1);
    expect(s.calls[1].auth).toBe("Bearer new");
    const s2 = scripted(json({}, 401));
    await expect(createYahooGet({ ...deps, fetchFn: s2.fetchFn })("x")).rejects.toMatchObject({ code: "AUTH" });
    expect(s2.calls).toHaveLength(2);
  });

  it("retries 429/5xx with backoff up to 3 times", async () => {
    const waits: number[] = [];
    const s = scripted(json({}, 429), json({}, 503), json({ ok: 1 }));
    const get = createYahooGet({ fetchFn: s.fetchFn, getToken: async () => "t", sleep: async (ms) => void waits.push(ms), backoffMs: 100 });
    expect(await get("x")).toEqual({ ok: 1 });
    expect(waits).toEqual([100, 200]);
    const s2 = scripted(json({}, 429));
    await expect(createYahooGet({ fetchFn: s2.fetchFn, getToken: async () => "t", sleep: noSleep })("x")).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(s2.calls).toHaveLength(4);
    const s3 = scripted(json({}, 500));
    await expect(createYahooGet({ fetchFn: s3.fetchFn, getToken: async () => "t", sleep: noSleep })("x")).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("maps 404/400 -> NOT_FOUND, bad JSON -> PARSE, fetch failure -> NETWORK, in-body error -> NOT_FOUND/AUTH", async () => {
    const mk = (r: Response | Error) => createYahooGet({ fetchFn: scripted(r).fetchFn, getToken: async () => "t", sleep: noSleep });
    await expect(mk(json({}, 404))("x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mk(json({}, 400))("x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mk(new Response("<html>", { status: 200 }))("x")).rejects.toMatchObject({ code: "PARSE" });
    await expect(mk(new TypeError("fetch failed"))("x")).rejects.toMatchObject({ code: "NETWORK" });
    await expect(mk(json({ error: { description: "Resource missing" } }))("x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mk(json({ error: { description: "token_expired" } }))("x")).rejects.toMatchObject({ code: "AUTH" });
  });
});

describe("oauth", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yahoo-oauth-"));
  });
  afterEach(() => {
    delete process.env.YAHOO_CLIENT_ID;
    delete process.env.YAHOO_CLIENT_SECRET;
  });
  const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "oob" };

  it("config errors are AUTH YahooErrors that never echo secrets", () => {
    expect(() => getYahooConfig({})).toThrow(YahooError);
    expect(getYahooConfig({ YAHOO_CLIENT_ID: "a", YAHOO_CLIENT_SECRET: "b" }).redirectUri).toBe("oob");
  });

  it("auth url", () => {
    const u = new URL(buildAuthUrl(cfg));
    expect(u.origin + u.pathname).toBe("https://api.login.yahoo.com/oauth2/request_auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "cid", redirect_uri: "oob", response_type: "code", language: "en-us" });
  });

  it("exchanges a code with Basic auth and form body; computes expires_at", async () => {
    let seen: { headers: Headers; body: string } | null = null;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen = { headers: new Headers(init.headers), body: String(init.body) };
      return json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "bearer" });
    }) as unknown as typeof fetch;
    const t = await exchangeCode("abc123", cfg, fetchFn);
    expect(seen!.headers.get("authorization")).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(seen!.body))).toEqual({ grant_type: "authorization_code", redirect_uri: "oob", code: "abc123" });
    expect(t.expires_at).toBeGreaterThan(Date.now() + 3_000_000);
    expect(t).toMatchObject({ access_token: "AT", refresh_token: "RT" });
  });

  it("rejected code -> AUTH without leaking credentials", async () => {
    const fetchFn = (async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
    const e = await exchangeCode("bad", cfg, fetchFn).catch((x) => x);
    expect(e).toMatchObject({ code: "AUTH" });
    expect(e.message).not.toMatch(/sec/);
  });

  it("save/load round trip, status, refreshIfNeeded only refreshes when expiring", async () => {
    const file = path.join(dir, "t.json");
    expect(loadTokens(file)).toBeNull();
    expect(tokenStatus(file).tokensPresent).toBe(false);
    saveTokens({ access_token: "A1", refresh_token: "R1", token_type: "bearer", expires_at: Date.now() + 3_600_000 }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(tokenStatus(file)).toMatchObject({ tokensPresent: true, expired: false });
    process.env.YAHOO_CLIENT_ID = "cid";
    process.env.YAHOO_CLIENT_SECRET = "sec";
    let n = 0;
    const fetchFn = (async () => (n++, json({ access_token: "A2", expires_in: 3600 }))) as unknown as typeof fetch;
    expect((await refreshIfNeeded({ file, fetchFn })).access_token).toBe("A1");
    expect(n).toBe(0);
    const t = await refreshIfNeeded({ file, fetchFn, force: true });
    expect(t).toMatchObject({ access_token: "A2", refresh_token: "R1" }); // refresh token kept when Yahoo omits it
    expect(loadTokens(file)!.access_token).toBe("A2");
    expect(n).toBe(1);
    saveTokens({ ...t, expires_at: Date.now() - 1 }, file);
    expect(tokenStatus(file).expired).toBe(true);
    await refreshIfNeeded({ file, fetchFn });
    expect(n).toBe(2);
  });

  it("missing tokens -> AUTH with guidance", async () => {
    await expect(refreshIfNeeded({ file: path.join(dir, "none.json") })).rejects.toMatchObject({ code: "AUTH", message: expect.stringContaining("yahoo:auth") });
  });
});
