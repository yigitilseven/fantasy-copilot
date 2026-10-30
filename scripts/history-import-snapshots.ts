import { getDb } from "../src/db/client";
import { listDraftSummaries } from "../src/db/history";
import { importSnapshots } from "../src/integrations/yahoo/snapshot-import";

/** pnpm history:import-snapshots [--draft=7] [--room=2675311/13] [--dir=data/cache] */
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const db = getDb();
const draftId = Number(arg("draft") ?? 0);
if (!draftId) {
  console.error("Usage: pnpm history:import-snapshots --draft=<id> [--room=<leagueId>/<team>] [--dir=data/cache]");
  console.error("Drafts: " + listDraftSummaries(db).map((d) => `#${d.id} ${d.createdAt.slice(0, 10)} ${d.kind} ${d.picks} picks`).join(" | "));
  process.exit(1);
}
const r = importSnapshots(db, draftId, { room: arg("room"), dir: arg("dir") });
console.log(JSON.stringify(r, null, 2));
if (!r.files) {
  console.error("No snapshots found for that room.");
  process.exit(1);
}
