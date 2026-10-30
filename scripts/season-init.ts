/**
 * pnpm season:init --draft=12 [--reset] [--name="..."]
 * Bootstraps Season mode from a finished draft: league + 14 teams (Yahoo names from draft_team) + every roster from the draft's picks.
 * Idempotent: running it again prints the existing league; --reset re-seeds the rosters from the draft (settings are kept).
 */
import { getDb } from "../src/db/client";
import { createLeagueFromDraft, getRosters, getTeams } from "../src/db/season";
import { players } from "../src/db/schema";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.slice(a.indexOf("=") + 1) : "true";
}

const draft = Number(arg("draft"));
if (!Number.isInteger(draft) || draft <= 0) {
  console.error("usage: pnpm season:init --draft=<draft id> [--reset] [--name=...]");
  process.exit(2);
}
const db = getDb();
const { league, created } = createLeagueFromDraft(db, draft, { reset: arg("reset") === "true", name: arg("name") });
const names = new Map(db.select({ id: players.id, name: players.name }).from(players).all().map((p) => [p.id, p.name]));
console.log(`${created ? "Created" : "Existing"} league #${league.id} "${league.name}" (${league.teams} teams, from draft ${draft}${league.yahooLeagueKey ? `, Yahoo ${league.yahooLeagueKey}` : ""})`);
console.log(`Settings: ${league.settings.rosterSlots.join(",")} + ${league.settings.benchSlots} BN + ${league.settings.ilSlots} IL, ${league.settings.weeklyAddLimit} adds/week, lineups ${league.settings.lineupLock}, tz ${league.settings.timezone}`);
const rosters = getRosters(db, league.id);
for (const t of getTeams(db, league.id)) {
  const r = rosters.get(t.slot) ?? [];
  console.log(`  ${String(t.slot).padStart(2)} ${t.name}${t.isUser ? "  <- you" : ""} (${r.length})${t.isUser ? `: ${r.map((x) => names.get(x.playerId) ?? x.playerId).join(", ")}` : ""}`);
}
