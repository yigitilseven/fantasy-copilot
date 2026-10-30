import { redirect } from "next/navigation";

/** The old single-page Season view moved to the Copilot screens (Today, Moves, Matchup, League, Settings). */
export default function SeasonPage() {
  redirect("/today");
}
