/**
 * Web-push subscription helper for the modern surfaces.
 *
 * Ported from the legacy my-day.html / admin _shell.js flows when those
 * pages were removed in the legacy-interface cutover — this is now the
 * ONLY place the product registers /sw.js and creates PushSubscriptions.
 *
 * Server contract (api/notifications.js):
 *   GET  /api/notifications?action=public-key  → { publicKey }   (503 when unconfigured)
 *   POST /api/notifications?action=subscribe   → { ok: true }    (per-user upsert by endpoint)
 *
 * Honest states, no silent lies: callers receive a precise outcome and
 * render it; nothing here fakes a subscription.
 */

export type PushSetupOutcome =
  | "subscribed"
  | "unsupported"
  | "denied"
  | "not-configured"
  | "failed";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Register the product service worker (push delivery + legacy-cache purge). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Ensure this device holds a live push subscription for the signed-in user.
 *
 * `mode: "silent"` never prompts — it only (re)subscribes when notification
 * permission is ALREADY granted (used on shell mount so crews migrating off
 * the deleted legacy pages keep their reminders without re-opting-in).
 * `mode: "prompt"` is the explicit opt-in button path.
 */
export async function ensurePushSubscription(
  mode: "silent" | "prompt"
): Promise<PushSetupOutcome> {
  if (!pushSupported()) return "unsupported";

  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted" && mode === "silent") return "failed";

  const reg = await registerServiceWorker();
  if (!reg) return "failed";

  try {
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return "denied";
    }

    const keyRes = await fetch("/api/notifications?action=public-key", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (keyRes.status === 503) return "not-configured";
    if (!keyRes.ok) return "failed";
    const { publicKey } = (await keyRes.json()) as { publicKey?: string };
    if (!publicKey) return "not-configured";

    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    const saveRes = await fetch("/api/notifications?action=subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
      cache: "no-store",
    });
    return saveRes.ok ? "subscribed" : "failed";
  } catch {
    return "failed";
  }
}
