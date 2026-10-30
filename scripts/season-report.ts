/**
 * pnpm season:report [--date=YYYY-MM-DD] [--json]
 * League analysis from the current rosters (draft + Yahoo transactions + synced pages) and the blended projections: your rank in each category,
 * head-to-head odds against all 13 opponents, positional depth, best adds from the captured free-agent pool, drop candidates.
 */
import { getDb } from "../src/db/client";
import { renderReportText } from "../src/engine/season/report";
import { computeSeasonReport } from "../src/server/season-report";

const val = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const r = computeSeasonReport(getDb(), { date: val("date") });
if (!r) {
  console.error("No season league yet. Run: pnpm season:init --draft=<id>");
  process.exit(1);
}
console.log(process.argv.includes("--json") ? JSON.stringify(r, null, 2) : renderReportText(r));
