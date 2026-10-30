/** pnpm notify "message" [--title=T] [--level=info|warn|alert]   |   pnpm notify --test   (sends a test message to every configured channel) */
import { anyDelivered, configuredChannels, loadNotifyConfig, notify, type NotifyLevel } from "../src/ops/notify";

const val = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const text = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");

async function main() {
  const cfg = loadNotifyConfig();
  const ch = configuredChannels(cfg);
  console.log(`Channels configured: ${ch.length ? ch.join(", ") : "none (set APP_URL for push, and/or SMTP_HOST+SMTP_TO)"}`);
  const test = process.argv.includes("--test");
  if (!test && !text) {
    console.error('usage: pnpm notify "message" | pnpm notify --test');
    process.exit(2);
  }
  const res = await notify({ title: val("title") ?? (test ? "Test notification" : undefined), body: test ? `Push is working. ${new Date().toISOString()}` : text, level: (val("level") as NotifyLevel) ?? "info" }, cfg);
  for (const r of res) console.log(`${r.channel}: ${r.ok ? "sent" : `FAILED ${r.error}`}`);
  process.exit(anyDelivered(res) ? 0 : 1);
}
void main();
