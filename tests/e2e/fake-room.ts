import fs from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";

// Fake Yahoo draft room (Players tab in the 2026-27 projection view with a lazily rendered scroll container, a Picks / Queue side panel
// and the header) driven by the real userscript against the real app on :3100.
export const YAHOO_URL = "https://basketball.fantasysports.yahoo.com/nba/12345/draft";
export const APP = "http://localhost:3100";
const SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../extension/yahoo-draft-reader.user.js"), "utf8");

export interface P { player: { id: string; name: string; nbaTeam: string; positions: string[] }; projection: { pts: number; games: number; projectionSource?: string }; market: { rank: number } }

const abbr = (name: string) => {
  const parts = name.split(" ");
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
};

export function room(players: P[], total: number): string {
  const data = players.slice(0, total).map((p, i) => ({ id: String(1000 + i), name: abbr(p.player.name), team: p.player.nbaTeam, pos: p.player.positions.join(","), boost: i === 0 }));
  return `<!doctype html><html><head><title>Yahoo draft</title></head><body>
<div id="hdr"><span>00:30</span><span id="clock">Drafter ZZ's Pick • Round 1, Pick 3</span><div><span>Last:</span><span>${data[1].name}</span><span>(${data[1].pos} · ${data[1].team})</span></div></div>
<div id="side"></div>
<select id="stat-mode-filter" name="stat-mode-filter"><option value="projected">2026-27 Proj Stats</option><option value="average">2025-26 Average Stats</option><option value="season">2025-26 Total Stats</option><option value="advancedstats">2025-26 Advanced Stats y+</option></select>
<div id="scroller" tabindex="0" style="height:300px;overflow-y:auto;border:1px solid #888"><div><table><thead><tr>
<th>Player</th><th>XRank</th><th>Rank</th><th>ADP</th><th>GP</th><th>FG%</th><th>FT%</th><th>3PTM</th><th>PTS</th><th>REB</th><th>AST</th><th>ST</th><th>BLK</th><th>TO</th></tr></thead><tbody id="tb"></tbody></table></div></div>
<script>
const DATA=${JSON.stringify(data)};
let shown=0;
const tb=document.getElementById('tb'), sc=document.getElementById('scroller');
function more(){ const end=Math.min(DATA.length, shown+30); for(;shown<end;shown++){ const d=DATA[shown];
  const pts=d.boost?3500:1200+shown*10;
  tb.insertAdjacentHTML('beforeend','<tr><td><div class="ys-player" data-id="'+d.id+'"><img title="'+d.name+'"><div><div><span>'+d.name+'</span></div><ul><li><abbr><span>'+d.pos+'</span></abbr></li><li><abbr><span>'+d.team+'</span></abbr></li></ul></div></div></td><td>'+(shown+1)+'</td><td>'+(shown+1)+'</td><td>-</td><td>70</td><td>.480</td><td>.800</td><td>120</td><td>'+pts+'</td><td>400</td><td>300</td><td>60</td><td>30</td><td>110</td></tr>'); } }
more();
// lazy rendering: a new page of rows only after the user scrolls near the bottom (like Yahoo's infinite list)
sc.addEventListener('scroll',()=>{ if(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-40) setTimeout(more,150); });
const feedRow=(n,d)=>'<div class="feedrow"><span>'+n+'</span><div><span>Team '+n+'</span><div class="ys-player" data-id="'+d.id+'"><img title="'+d.name+'"><div><div><span>'+d.name+'</span></div><ul><li><abbr><span>'+d.pos+'</span></abbr></li><li><abbr><span>'+d.team+'</span></abbr></li></ul></div></div></div></div>';
window.showPanel=(w)=>{ document.getElementById('side').innerHTML = w==='picks' ? '<div role="tablist"><button role="tab" data-id="queue" aria-selected="false">Queue</button><button role="tab" data-id="picks" aria-selected="true">Picks</button></div>'+feedRow(1,DATA[0])+feedRow(2,DATA[1]) : '<div role="tablist"><button role="tab" data-id="queue" aria-selected="true">Queue</button><button role="tab" data-id="picks" aria-selected="false">Picks</button></div><div>Your queue is empty.</div>'; };
window.showPanel('picks');
</script></body></html>`;
}

export async function openRoom(page: Page, html: string) {
  await page.route("https://basketball.fantasysports.yahoo.com/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.addInitScript((origin) => {
    (window as unknown as { __FDC_ORIGIN: string }).__FDC_ORIGIN = origin;
  }, APP);
  // GM.xmlHttpRequest shim: the real one is performed by the extension (no CORS / mixed content); here Node does it.
  await page.exposeFunction("__gmRequest", async (d: { method: string; url: string; headers?: Record<string, string>; data?: string }) => {
    const res = await fetch(d.url, { method: d.method, headers: d.headers, body: d.data });
    return { status: res.status, text: await res.text() };
  });
  await page.addInitScript(() => {
    type D = { method: string; url: string; headers?: Record<string, string>; data?: string; onload: (r: { status: number; responseText: string }) => void; onerror: () => void };
    (window as unknown as { GM: unknown }).GM = {
      xmlHttpRequest(d: D) {
        (window as unknown as { __gmRequest: (d: unknown) => Promise<{ status: number; text: string }> })
          .__gmRequest({ method: d.method, url: d.url, headers: d.headers, data: d.data })
          .then((r) => d.onload({ status: r.status, responseText: r.text }), () => d.onerror());
      },
    };
  });
  await page.goto(YAHOO_URL);
  await page.addScriptTag({ content: SCRIPT });
}

export const top = async (request: import("@playwright/test").APIRequestContext) =>
  ((await (await request.get("/api/players")).json()) as P[]).sort((a, b) => a.market.rank - b.market.rank);

export async function newAppPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem("fdc:browserSync", "1"));
  const page = await ctx.newPage();
  await page.goto("/draft");
  await expect(page.getByTestId("current-pick")).toBeVisible();
  return page;
}

