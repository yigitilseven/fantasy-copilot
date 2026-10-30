/** Runs once per server start: Season mode's daily upkeep (schedule + news refresh, daily brief) while the app is running. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ getDb }, { startSeasonScheduler }] = await Promise.all([import("@/db/client"), import("@/server/season-daily")]);
  startSeasonScheduler(getDb);
}
