/**
 * pnpm season:brief [--refresh] [--date=YYYY-MM-DD] [--no-fetch] [--json]
 * Prints today's Season-mode brief (start/sit, matchup, add/drop moves, alerts) in the terminal. Meant to be run by a scheduled job later (this
 * repository installs no scheduler). Unless --no-fetch, it first runs the daily upkeep (NBA schedule if > 24 h old, news if > 6 h old).
 * The brief is stored once per game day; --refresh regenerates it.
 */
import { getDb } from "../src/db/client";
import { runDailyRefresh } from "../src/server/season-daily";
import { getOrCreateBrief, renderBriefText } from "../src/server/season-brief";

const has = (n: string) => process.argv.includes(`--${n}`);
const val = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main() {
  const db = getDb();
  if (!has("no-fetch")) {
    const r = await runDailyRefresh(db, { force: true });
    if (r.schedule.error) console.error(`(${r.schedule.error}; ${r.schedule.games ? "using the cached schedule" : "assuming 3.5 games per week"})`);
  }
  const res = getOrCreateBrief(db, { force: has("refresh"), date: val("date") });
  if (!res) {
    console.error("No season league yet. Run: pnpm season:init --draft=<id>");
    process.exit(1);
  }
  console.log(has("json") ? JSON.stringify(res.brief, null, 2) : renderBriefText(res.brief));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
