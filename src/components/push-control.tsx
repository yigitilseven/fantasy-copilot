"use client";

import { useCallback, useEffect, useState } from "react";
import { pushUiState, type PushEnv } from "@/lib/push-client";

/* "Enable notifications" for the installed PWA (Web Push). iOS only allows it for the Home Screen app and only from a tap. */

const b64ToBytes = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function readEnv(): Promise<PushEnv> {
  const hasSW = "serviceWorker" in navigator;
  let subscribed = false;
  if (hasSW) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      subscribed = !!(await reg?.pushManager?.getSubscription());
    } catch {
      /* ignore */
    }
  }
  return {
    userAgent: navigator.userAgent,
    standalone: (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    secure: window.isSecureContext,
    hasServiceWorker: hasSW,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : "default",
    subscribed,
  };
}

export function usePushState() {
  const [env, setEnv] = useState<PushEnv | null>(null);
  const refresh = useCallback(() => void readEnv().then(setEnv), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { env, ui: env ? pushUiState(env) : null, refresh };
}

/** Small bell for top bars: dot colour = state, tap goes to the full control in Settings. */
export function PushBell() {
  const { ui } = usePushState();
  const on = ui?.state === "enabled";
  return (
    <a href="/settings#notifications" data-testid="push-bell" title={ui?.message ?? "Notifications"} className="inline-flex items-center gap-1 rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[11px] hover:bg-zinc-700">
      <span aria-hidden>🔔</span>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-400" : ui?.state === "blocked" ? "bg-red-400" : "bg-zinc-500"}`} />
    </a>
  );
}

/** Push state plus the enable / turn off / send test actions (shared by this control and the Copilot screens). */
export function usePush() {
  const { ui, refresh } = usePushState();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    setMsg("");
    try {
      const k = await fetch("/api/push/public-key", { cache: "no-store" });
      if (!k.ok) throw new Error(((await k.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${k.status}`);
      const { publicKey } = (await k.json()) as { publicKey: string };
      const perm = await Notification.requestPermission(); // must happen inside this tap
      if (perm !== "granted") throw new Error("Permission was not granted");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!r.ok) throw new Error(`Saving the subscription failed (HTTP ${r.status})`);
      setMsg("Enabled. Tap \"Send test\" to check.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setMsg("Notifications turned off for this device.");
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/push/test", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { sent?: number; subscriptions?: number; configured?: boolean };
      setMsg(r.status === 503 ? "Push is not configured on the server (VAPID keys)." : j.sent ? `Test sent to ${j.sent} device(s).` : j.subscriptions ? "The push service rejected the test; try turning notifications off and on." : "No device subscribed yet.");
    } finally {
      setBusy(false);
    }
  };

  return { ui, msg, busy, enable, disable, test };
}

export default function PushControl() {
  const { ui, msg, busy, enable, disable, test } = usePush();
  if (!ui) return null;
  const btn = "rounded bg-sky-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-sky-600 disabled:opacity-50";
  const ghost = "rounded bg-zinc-800 px-3 py-1.5 text-[13px] hover:bg-zinc-700 disabled:opacity-50";
  return (
    <section id="notifications" data-testid="push-control" data-state={ui.state} className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <h2 className="text-[12px] font-semibold text-zinc-100">🔔 Notifications</h2>
      <p className="mt-1 text-zinc-300" data-testid="push-message">{ui.message}</p>
      {ui.steps && (
        <ol className="mt-1 list-decimal pl-5 text-zinc-400" data-testid="push-steps">
          {ui.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ui.state === "can-enable" && <button className={btn} disabled={busy} onClick={() => void enable()} data-testid="push-enable">Enable notifications</button>}
        {ui.state === "enabled" && (
          <>
            <button className={btn} disabled={busy} onClick={() => void test()} data-testid="push-test">Send test</button>
            <button className={ghost} disabled={busy} onClick={() => void disable()}>Turn off</button>
          </>
        )}
        {msg && <span className="text-zinc-400" data-testid="push-result">{msg}</span>}
      </div>
    </section>
  );
}
