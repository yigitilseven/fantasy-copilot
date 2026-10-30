import { SeasonProvider } from "@/ui/season-data";
import { AppShell } from "@/ui/shell";

/** Today, Moves, Matchup, League and Settings share one data source and the app chrome. The draft room keeps its own layout. */
export default function CopilotLayout({ children }: LayoutProps<"/">) {
  return (
    <SeasonProvider>
      <AppShell>{children}</AppShell>
    </SeasonProvider>
  );
}
