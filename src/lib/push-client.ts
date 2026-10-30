/** Pure decision logic for the "Enable notifications" control (iOS only delivers Web Push to a PWA opened from the Home Screen). */
export interface PushEnv {
  userAgent: string;
  /** navigator.standalone (iOS) or display-mode: standalone */
  standalone: boolean;
  secure: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: "default" | "granted" | "denied";
  subscribed: boolean;
}
export type PushUi = "unsupported" | "insecure" | "install-needed" | "blocked" | "can-enable" | "enabled";

export const isIOS = (ua: string) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));

export function pushUiState(e: PushEnv): { state: PushUi; message: string; steps?: string[] } {
  if (!e.secure) return { state: "insecure", message: "Push needs HTTPS. Open the app at https://fantasy.example.com (it does not work over http or an SSH tunnel)." };
  if (isIOS(e.userAgent) && !e.standalone)
    return {
      state: "install-needed",
      message: "On iPhone, notifications work only for the app installed on the Home Screen.",
      steps: ["Open this page in Safari.", "Tap Share, then \"Add to Home Screen\".", "Open Draft Copilot from the new Home Screen icon.", "Tap \"Enable notifications\" there."],
    };
  if (!e.hasServiceWorker || !e.hasPushManager || !e.hasNotification) return { state: "unsupported", message: "This browser does not support Web Push (iPhone needs iOS 16.4 or newer, with the app added to the Home Screen)." };
  if (e.permission === "denied") return { state: "blocked", message: "Notifications are blocked. Re-enable them in iOS Settings > Notifications > Copilot (or the browser's site settings)." };
  if (e.permission === "granted" && e.subscribed) return { state: "enabled", message: "Notifications are on for this device." };
  return { state: "can-enable", message: "Get your morning brief and move alerts on this phone." };
}
