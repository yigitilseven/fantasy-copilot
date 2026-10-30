/**
 * pnpm season:ingest-file <file.html> [--kind=team|players|matchup|transactions] [--team-id=9] [--mine]
 * Parses a saved Yahoo league page (data/cache/season-*.html, written by the userscript's auto-samples / "Send snapshot") with the same parsers
 * and ingest code as the live userscript and stores the result. The kind comes from the file name (season-<kind>-<ts>.html) unless given.
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { getDb } from "../src/db/client";
import { discoverBody, freeAgentsBody, ingestDiscovery, ingestFreeAgents, ingestMatchup, ingestRoster, ingestTransactions, matchupBody, rosterBody, transactionsBody } from "../src/server/season-ingest";
import { resetSeasonPlayerCache } from "../src/server/season-players";
import { discoverLeague, parseSeasonMatchup, parseSeasonPlayers, parseSeasonRoster, parseSeasonTransactions, parseSeasonUrl, slimSeasonRows } from "../extension/parser.js";

const file = process.argv[2];
const val = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
if (!file) {
  console.error("usage: pnpm season:ingest-file <file.html> [--kind=team|players|matchup|transactions] [--team-id=ID] [--mine]");
  process.exit(1);
}
const html = fs.readFileSync(file, "utf8");
const url = /^<!-- url: (\S+) -->/.exec(html)?.[1] ?? "";
const kind = val("kind") ?? /season-(team|roster|players|matchup|transactions)-/.exec(path.basename(file))?.[1] ?? parseSeasonUrl(url).kind;
const doc = new JSDOM(html.replace(/^<!-- url:.*?-->\n?/, ""), { url: url || "https://basketball.fantasysports.yahoo.com/" }).window.document;
const db = getDb();
const sp = parseSeasonUrl(url);

const disc = discoverLeague(doc, url);
if (disc.leagueId) {
  const r = ingestDiscovery(db, discoverBody.parse({ leagueId: disc.leagueId, myTeamId: disc.myTeamId ?? undefined, teams: disc.teams }));
  console.log(`discovery: ${r.mapped}/${r.teams.length} teams mapped, your Yahoo team id ${r.userTeamId}`);
}
if (kind === "team" || kind === "roster") {
  const r = parseSeasonRoster(doc);
  const tid = val("team-id") ?? sp.teamId ?? undefined;
  const out = ingestRoster(db, rosterBody.parse({ url, teamName: r.teamName ?? undefined, teamId: tid, mine: process.argv.includes("--mine") || (!!tid && tid === r.myTeamId), players: slimSeasonRows(r.rows) }));
  console.log(`roster ${out.team.name}: ${out.matched} matched, ${out.unmatched.length} unmatched, +${out.added.length} -${out.dropped.length}`);
  for (const row of r.rows as Record<string, string>[]) console.log(`  ${String(row.slot).padEnd(5)} ${row.playerName} ${row.nbaTeam ?? ""} ${row.positions ?? ""} ${row.injuryTag ?? ""}`);
} else if (kind === "players") {
  const rows = parseSeasonPlayers(doc).rows;
  const out = ingestFreeAgents(db, freeAgentsBody.parse({ url, players: slimSeasonRows(rows).slice(0, 300) }));
  console.log(`free agents: ${out.received} read, ${out.matched} matched, pool ${out.poolSize}`);
} else if (kind === "matchup") {
  const m = parseSeasonMatchup(doc, sp.leagueId);
  if (!m.found) throw new Error("no matchup found on this page");
  const out = ingestMatchup(db, matchupBody.parse({ url, week: m.week, teams: m.teams }));
  console.log(`matchup week ${m.week}: ${m.teams.map((t: { name: string }) => t.name).join(" vs ")} -> ${JSON.stringify(out)}`);
  for (const t of m.teams) console.log(`  ${t.name}: ${JSON.stringify(t.cats)} gp ${t.gamesPlayed ?? "-"} rem ${t.gamesRemaining ?? "-"}`);
} else if (kind === "transactions") {
  const rows = parseSeasonTransactions(doc).rows;
  if (!rows.length) throw new Error("no transactions found on this page");
  console.log(`transactions: ${JSON.stringify(ingestTransactions(db, transactionsBody.parse({ url, rows })))}`);
} else throw new Error(`unknown kind ${kind}`);
resetSeasonPlayerCache(db);
