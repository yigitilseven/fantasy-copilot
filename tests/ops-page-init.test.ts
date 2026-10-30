import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { buildInitScript, makeAppForwarder } from "@/ops/page-init";

const ROOT = path.resolve(__dirname, "..");
const userscript = fs.readFileSync(path.join(ROOT, "extension/yahoo-draft-reader.user.js"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "extension/userscript.src.js"), "utf8");
const teamHtml = fs.readFileSync(path.join(__dirname, "fixtures-season-real/team.html"), "utf8");

const okPart = { ok: true, detail: "" };
const syncStatus = () => ({
  league: { id: 1, name: "L", teams: 14 }, lastAttemptAt: new Date().toISOString(), lastFullAt: new Date().toISOString(), stopped: null, requests: 0,
  parts: { discovery: okPart, myTeam: okPart, teams: okPart, matchup: okPart, fas: okPart, transactions: okPart },
  roster: { count: 13, syncedAt: null, source: "yahoo-page" }, teamsSynced: 14, teamsTotal: 14, matchup: { opp: null, week: null, at: null }, freeAgents: { count: 0, at: null },
  transactions: { count: 0, lastOn: null }, parserNeedsUpdate: [],
});

describe("userscript origin override hook", () => {
  it("is backward compatible: default origin and no forced sync", () => {
    expect(src).toContain('window.__FDC_ORIGIN) || "http://localhost:3000"');
    expect(userscript).toContain('"http://localhost:3000"');
    expect(src).toMatch(/window\.__FDC_FORCE_SYNC === true && !sstate\.forcedDone/);
    expect(userscript).toContain("@version      0.7.3");
  });
});

describe("worker init script", () => {
  it("injects origin, GM shim and the userscript; requests go to the injected origin through the binding", async () => {
    const calls: { method: string; url: string }[] = [];
    const dom = new JSDOM(teamHtml, { url: "https://basketball.fantasysports.yahoo.com/nba/100001/9", runScripts: "outside-only", pretendToBeVisual: true });
    const w = dom.window as unknown as Record<string, unknown> & { eval(s: string): unknown; localStorage: Storage };
    w.__fdcBind = async (r: { method: string; url: string }) => {
      calls.push({ method: r.method, url: r.url });
      if (r.url.endsWith("/api/season/status")) return { status: 200, text: JSON.stringify({ league: { id: 1, name: "L", teams: 14 }, fetchFreeAgentPages: true }) };
      if (r.url.endsWith("/api/season/sync-status")) return { status: 200, text: JSON.stringify(syncStatus()) }; // fresh: normal gate would NOT sync
      return { status: 200, text: "{}" };
    };
    w.localStorage.setItem("fdc:season", JSON.stringify({ lastAttemptAt: Date.now() })); // and an attempt a moment ago
    w.eval(buildInitScript({ userscript, origin: "http://app:3000", binding: "__fdcBind", forceSync: true }));
    expect(w.__FDC_ORIGIN).toBe("http://app:3000");
    await new Promise((r) => setTimeout(r, 4900)); // autoSyncDelayMs = 4 s
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.startsWith("http://app:3000/api/"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/season/discover"))).toBe(true); // forced sync started despite the fresh server sync
    dom.window.close();
  }, 15_000);

  it("without the force flag the same page does not start a sync (gate unchanged)", async () => {
    const calls: string[] = [];
    const dom = new JSDOM(teamHtml, { url: "https://basketball.fantasysports.yahoo.com/nba/100001/9", runScripts: "outside-only", pretendToBeVisual: true });
    const w = dom.window as unknown as Record<string, unknown> & { eval(s: string): unknown };
    w.__fdcBind = async (r: { url: string }) => {
      calls.push(r.url);
      if (r.url.endsWith("/api/season/status")) return { status: 200, text: JSON.stringify({ league: { id: 1, name: "L", teams: 14 } }) };
      if (r.url.endsWith("/api/season/sync-status")) return { status: 200, text: JSON.stringify(syncStatus()) };
      return { status: 200, text: "{}" };
    };
    w.eval(buildInitScript({ userscript, origin: "http://app:3000", binding: "__fdcBind", forceSync: false }));
    await new Promise((r) => setTimeout(r, 4900));
    expect(calls.some((u) => u.endsWith("/api/season/discover"))).toBe(false);
    dom.window.close();
  }, 15_000);
});

describe("app forwarder (Node side of the shim)", () => {
  it("only forwards GET/POST to the app's /api paths", async () => {
    const f = vi.fn(async () => new Response('{"ok":1}', { status: 201 }));
    const fwd = makeAppForwarder("http://app:3000", f as never);
    expect(await fwd({ method: "POST", url: "http://app:3000/api/season/roster", data: "{}" })).toEqual({ status: 201, text: '{"ok":1}' });
    expect(f).toHaveBeenCalledWith("http://app:3000/api/season/roster", expect.objectContaining({ method: "POST", body: "{}" }));
    await expect(fwd({ method: "GET", url: "http://evil.example/api/x" })).rejects.toThrow(/blocked/);
    await expect(fwd({ method: "GET", url: "http://app:3000/_next/secret" })).rejects.toThrow(/blocked/);
    await expect(fwd({ method: "DELETE", url: "http://app:3000/api/season/roster" })).rejects.toThrow(/blocked/);
  });
});

describe("buildInitScript fullSync", () => {
  it("sets __FDC_SYNC_FULL only when asked", () => {
    expect(buildInitScript({ userscript: "", origin: "http://app:3000", binding: "b", fullSync: true })).toContain("window.__FDC_SYNC_FULL = true;");
    expect(buildInitScript({ userscript: "", origin: "http://app:3000", binding: "b" })).not.toContain("__FDC_SYNC_FULL = true");
  });
});
