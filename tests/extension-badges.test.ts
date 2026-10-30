/* eslint-disable @typescript-eslint/no-explicit-any -- jsdom window with an injected GM.xmlHttpRequest shim and untyped userscript globals */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { findTablePlayers, parseDraftRoom } from "../extension/parser.js";

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures-extension", "yahoo-2026-room-trimmed.html"), "utf8");
const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "extension", "yahoo-draft-reader.user.js"), "utf8");
const b = (playerId: string, name: string, nbaTeam: string, state: string, score: number, rank: number) => ({ playerId, name, nbaTeam, state, score, rank });

const REC = {
  draftId: 7, currentPick: 17, totalPicks: 156, status: "in_progress", teams: 12, userSlot: 4, onClock: true, userNextPick: 17, picksUntilUser: 0,
  strategy: { preset: "punt-ft", riskTolerance: 0.15, puntedCategories: ["ft%"] },
  needs: ["pts", "reb", "ast", "stl", "blk", "3pm", "fg%", "ft%", "to"].map((category, i) => ({ category, weight: 1 - i * 0.1 })),
  roster: [{ pick: 4, playerId: "kat", name: "Karl-Anthony Towns", positions: ["PF", "C"], nbaTeam: "NYK" }],
  top: [
    { playerId: "jm", name: "Jamal Murray", nbaTeam: "DEN", positions: ["PG"], adp: 17.2, state: "DRAFT", score: 74.4, nineCat: 3.1, rosterFit: 1.2, survival: 0.05, riskLabel: "low", reason: "Best fit for your build" },
    { playerId: "at-hou", name: "Amen Thompson", nbaTeam: "HOU", positions: ["SG", "SF"], adp: 20, state: "WAIT", score: 66, nineCat: 2, rosterFit: 0.5, survival: 0.4, riskLabel: "medium", reason: "Likely to wait" },
  ],
  board: [
    b("jm", "Jamal Murray", "DEN", "DRAFT", 74.4, 1),
    b("at-hou", "Amen Thompson", "HOU", "WAIT", 66, 3),
    b("at-det", "Ausar Thompson", "DET", "AVOID", 41, 60),
    b("jjj", "Jaren Jackson Jr.", "MEM", "TAKE", 70, 2),
    b("asen", "Alperen Sengun", "HOU", "RISKY WAIT", 60, 11),
  ],
  generatedAt: "2026-10-07T00:00:00Z", simMs: 40,
};

let win: any;
afterEach(() => win?.close());

function boot(rec: any = REC) {
  const calls: { method: string; url: string; data?: string }[] = [];
  const dom = new JSDOM(FIXTURE, { url: "https://basketball.fantasysports.yahoo.com/nba/1/draft", runScripts: "outside-only", pretendToBeVisual: true });
  win = dom.window;
  win.GM = {
    xmlHttpRequest(d: any) {
      calls.push({ method: d.method, url: d.url, data: d.data });
      const reply = (status: number, body: unknown) => setTimeout(() => d.onload({ status, responseText: JSON.stringify(body) }), 0);
      if (d.url.endsWith("/api/draft/active-id")) reply(200, { id: 7, teams: 12 });
      else if (d.url.includes("/recommendations")) reply(200, rec);
      else if (d.url.endsWith("/external-picks")) reply(200, { ingested: 0, draft: { currentPick: 17 } });
      else if (d.url.endsWith("/strategy")) reply(200, {});
      else reply(404, {});
    },
  };
  win.eval(SCRIPT);
  return { doc: win.document as Document, calls };
}
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const badges = (doc: Document) => [...doc.querySelectorAll("[data-fdc-badge]")].map((e) => [e.getAttribute("data-fdc-badge"), e.textContent]);

describe("userscript on the real Yahoo snapshot fragment", () => {
  it("fixture: the feed is parsed as picks and table rows are separate", () => {
    const doc = new JSDOM(FIXTURE).window.document;
    expect(parseDraftRoom(doc).picks.map((p: { pick: number }) => p.pick)).toEqual([12, 15, 16]);
    expect(findTablePlayers(doc).length).toBe(10);
  });

  it("badges available players by initial+last+team, not feed rows, idempotent, and re-applies after re-render", async () => {
    const { doc } = boot();
    await until(() => doc.querySelectorAll("[data-fdc-badge]").length >= 4);
    const text = (el: Element) => el.textContent;
    const byName = (n: string, team: string) => findTablePlayers(doc).find((p: any) => p.name === n && p.nbaTeam === team)!;
    // (Yahoo lists Jackson Jr. under UTA, board says MEM: a unique name still matches)
    // Murray DEN -> DRAFT, Thompson HOU vs DET disambiguated by team, Jackson Jr. suffix, accent Sengun
    expect(text(byName("J. Murray", "DEN").el.querySelector("[data-fdc-badge]")!)).toBe("#1 DRAFT 74");
    expect(text(byName("A. Thompson", "HOU").el.querySelector("[data-fdc-badge]")!)).toBe("#3 WAIT 66");
    expect(text(byName("A. Thompson", "DET").el.querySelector("[data-fdc-badge]")!)).toBe("AVOID 41");
    expect(text(byName("J. Jackson Jr.", "UTA").el.querySelector("[data-fdc-badge]")!)).toBe("#2 TAKE 70");
    expect(text(byName("A. Şengün", "HOU").el.querySelector("[data-fdc-badge]")!)).toBe("RISKY WAIT 60");
    // players not on the board get none; feed rows never get one
    expect(byName("J. Giddey", "CHI").el.querySelector("[data-fdc-badge]")).toBeNull();
    const feed = doc.getElementById("feed")!;
    expect(feed.querySelector("[data-fdc-badge]")).toBeNull();
    const before = badges(doc);
    expect(new Set(before.map((x) => x[0])).size).toBe(before.length); // one badge per data-id
    expect(doc.querySelectorAll("[data-fdc-badge][data-fdc-ignore]").length).toBe(before.length);

    // Yahoo re-renders: wipe one badge's parent content and let the observer restore it
    const murray = byName("J. Murray", "DEN");
    murray.el.querySelector("[data-fdc-badge]")!.remove();
    murray.el.appendChild(doc.createElement("i")); // a foreign (Yahoo) mutation accompanies the re-render
    await until(() => !!byName("J. Murray", "DEN").el.querySelector("[data-fdc-badge]"));
    await new Promise((r) => setTimeout(r, 700));
    expect(badges(doc)).toEqual(before); // still exactly one per player (idempotent, no feedback loop growth)
    // parser still ignores the overlay and badges
    expect(parseDraftRoom(doc).picks.map((p: { pick: number }) => p.pick)).toEqual([12, 15, 16]);
    expect(parseDraftRoom(doc).picks[2].playerName).toBe("K. Towns");
  });

  it("overlay shows the DRAFT pick with its reason, header, needs and roster; strategy select sends PATCH", async () => {
    const { doc, calls } = boot();
    await until(() => !!doc.querySelector('[data-fdc="rec-row"]'));
    expect(doc.querySelector('[data-fdc="title"]')!.textContent).toBe("PICK 17 · YOU'RE UP");
    const hero = doc.querySelector('[data-fdc="rec-row"][data-state="DRAFT"]')!;
    expect(hero.textContent).toContain("Jamal Murray");
    expect(hero.textContent).toContain("Best fit for your build");
    expect(hero.textContent).toContain("Surv 5%");
    const wait = doc.querySelector('[data-fdc="rec-row"][data-state="WAIT"]')!;
    expect(wait.textContent).not.toContain("Likely to wait");
    (wait as HTMLElement).click();
    expect(doc.querySelector('[data-fdc="rec-row"][data-state="WAIT"]')!.textContent).toContain("Likely to wait");
    expect(doc.querySelectorAll('[data-fdc="need"]').length).toBe(9);
    expect(doc.querySelector('[data-fdc="need"][data-cat="ft%"]')!.getAttribute("data-punted")).toBe("1");
    expect(doc.querySelector('[data-fdc="roster"]')!.textContent).toContain("My roster (1/13)");
    expect(doc.querySelector('[data-fdc="chip"]')!.textContent).toBe("Punt FT%");
    const sel = doc.querySelector('[data-fdc="preset"]') as HTMLSelectElement;
    expect(sel.value).toBe("punt-ft");
    sel.value = "punt-to";
    sel.dispatchEvent(new win.Event("change"));
    await until(() => calls.some((c) => c.method === "PATCH"));
    const p = calls.find((c) => c.method === "PATCH")!;
    expect(p.url).toBe("http://localhost:3000/api/draft/7/strategy");
    expect(JSON.parse(p.data!)).toEqual({ preset: "punt-to" });
    const risk = doc.querySelector('[data-fdc="risk"]') as HTMLSelectElement;
    risk.value = "0.05";
    risk.dispatchEvent(new win.Event("change"));
    await until(() => calls.filter((c) => c.method === "PATCH").length === 2);
    expect(JSON.parse(calls.filter((c) => c.method === "PATCH")[1].data!)).toEqual({ riskTolerance: 0.05 });
  });

  it("shows 'Copilot app not running' when the app is unreachable", async () => {
    const dom = new JSDOM(FIXTURE, { url: "https://basketball.fantasysports.yahoo.com/nba/1/draft", runScripts: "outside-only", pretendToBeVisual: true });
    win = dom.window;
    win.GM = { xmlHttpRequest: (d: any) => setTimeout(() => d.onerror(), 0) };
    win.eval(SCRIPT);
    await until(() => (win.document.querySelector('[data-fdc="recerr"]')?.textContent ?? "").includes("Copilot app not running (pnpm dev)"));
  });
});

describe("statusMarker", () => {
  it("red O / OFS, amber DTD, nothing for healthy/unknown", async () => {
    const { statusMarker } = await import("../extension/parser.js");
    expect(statusMarker("out")).toMatchObject({ text: "O", color: "#dc2626" });
    expect(statusMarker("out-for-season")?.text).toBe("OFS");
    expect(statusMarker("day-to-day")).toMatchObject({ text: "DTD", color: "#d97706" });
    expect(statusMarker("healthy")).toBeNull();
    expect(statusMarker(undefined)).toBeNull();
  });
});
