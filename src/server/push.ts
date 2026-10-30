import { eq, sql } from "drizzle-orm";
import webpush from "web-push";
import type { Db } from "@/db/client";
import { pushSubscriptions } from "@/db/schema";
import { formatPushPayload, type PushPayload } from "@/lib/push-payload";

/** Web Push for the installed PWA. Keys: `pnpm push:vapid` -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in .env. */
type Env = Record<string, string | undefined>;
export interface Vapid { publicKey: string; privateKey: string; subject: string }

export function vapidFromEnv(env?: Env): Vapid | null {
  const read = (key: string) => (env ?? process.env)[key]?.trim();
  const publicKey = read("VAPID_PUBLIC_KEY");
  const privateKey = read("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: read("VAPID_SUBJECT") || "mailto:admin@example.com",
  };
}

export interface SubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
export type PushSender = (sub: SubscriptionInput, payload: string, vapid: Vapid) => Promise<unknown>;

const defaultSender: PushSender = (sub, payload, v) =>
  webpush.sendNotification(sub, payload, { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 6 * 3600, urgency: "high", timeout: 15_000 });

export function saveSubscription(db: Db, sub: SubscriptionInput, userAgent: string | null, now = new Date().toISOString()): "created" | "updated" {
  const existing = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).get();
  if (existing) {
    db.update(pushSubscriptions).set({ p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, failures: 0 }).where(eq(pushSubscriptions.id, existing.id)).run();
    return "updated";
  }
  db.insert(pushSubscriptions).values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, createdAt: now }).run();
  return "created";
}

export function removeSubscription(db: Db, endpoint: string): boolean {
  return db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run().changes > 0;
}

export function countSubscriptions(db: Db): number {
  return db.select({ n: sql<number>`count(*)` }).from(pushSubscriptions).get()?.n ?? 0;
}

export interface SendResult { subscriptions: number; sent: number; failed: number; removed: number; configured: boolean }

/** Sends to every subscribed device. 404/410 from the push service remove the subscription; other errors count as failures. */
export async function sendPushToAll(db: Db, input: Parameters<typeof formatPushPayload>[0], deps: { sender?: PushSender; vapid?: Vapid | null; now?: string } = {}): Promise<SendResult> {
  const vapid = deps.vapid === undefined ? vapidFromEnv() : deps.vapid;
  const rows = db.select().from(pushSubscriptions).all();
  const res: SendResult = { subscriptions: rows.length, sent: 0, failed: 0, removed: 0, configured: !!vapid };
  if (!vapid) return res;
  const payload: PushPayload = formatPushPayload(input);
  const body = JSON.stringify(payload);
  for (const r of rows) {
    try {
      await (deps.sender ?? defaultSender)({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body, vapid);
      db.update(pushSubscriptions).set({ lastOkAt: deps.now ?? new Date().toISOString(), failures: 0 }).where(eq(pushSubscriptions.id, r.id)).run();
      res.sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        removeSubscription(db, r.endpoint);
        res.removed++;
      } else {
        db.update(pushSubscriptions).set({ failures: r.failures + 1 }).where(eq(pushSubscriptions.id, r.id)).run();
        res.failed++;
      }
    }
  }
  return res;
}
