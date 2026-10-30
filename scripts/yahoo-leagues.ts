import { loadEnvLocal } from "../src/integrations/yahoo/config";
import { YahooDraftProvider } from "../src/integrations/yahoo/draft-provider";
import { isYahooError } from "../src/integrations/yahoo/errors";

async function main() {
  loadEnvLocal();
  const leagues = await new YahooDraftProvider().fetchLeagues();
  if (!leagues.length) return console.log("No NBA leagues found for this Yahoo account in the current season.");
  for (const l of leagues)
    console.log(`${l.leagueKey}\t${l.name}\tteams=${l.numTeams ?? "?"}\tdraft=${l.draftStatus ?? "?"}\tyour slot=${l.userSlot ?? "unknown"}`);
}

main().catch((e) => {
  console.error(isYahooError(e) ? `[${e.code}] ${e.message}` : `Error: ${(e as Error).message}`);
  process.exit(1);
});
