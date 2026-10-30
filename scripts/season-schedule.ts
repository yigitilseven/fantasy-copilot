/**
 * pnpm season:schedule [--file=path/to/scheduleLeagueV2.json] [--force]
 * Refreshes the cached NBA schedule (data/cache/nba-schedule.json). cdn.nba.com sometimes answers 403 to non-browser clients: save the file from a
 * browser (https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json) and import it with --file. Without a schedule the engines assume 3.5
 * games per week.
 */
import fs from "node:fs";
import { defaultStatsCacheDir } from "../src/integrations/projections/stats-lookup";
import { refreshSchedule, scheduleStatus, storeSchedule } from "../src/integrations/schedule/nba-schedule";

async function main() {
  const dir = defaultStatsCacheDir();
  const file = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
  if (file) {
    const d = storeSchedule(dir, fs.readFileSync(file, "utf8"));
    console.log(`Imported ${d.games} regular-season games (${d.firstDate} .. ${d.lastDate}), ${Object.keys(d.teams).length} teams.`);
    return;
  }
  const s = await refreshSchedule(dir, { force: process.argv.includes("--force"), log: (m) => console.log(m) });
  const st = scheduleStatus(dir);
  console.log(st.games ? `Schedule: ${st.games} games ${st.firstDate} .. ${st.lastDate}, fetched ${st.fetchedAt}${s.error ? ` (refresh failed: ${s.error}; using cache)` : ""}` : `No schedule${s.error ? `: ${s.error}` : ""}`);
  if (!st.games) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
