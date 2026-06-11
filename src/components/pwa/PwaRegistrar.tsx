"use client";

import { useEffect } from "react";
import { ensurePushSubscription, registerServiceWorker } from "@/lib/pwa/push";

/**
 * Invisible mount-time PWA wiring for the modern shells.
 *
 * - Registers /sw.js so the v9 worker takes over from the legacy one
 *   (purging the old buhl-shell-* caches) and keeps Web Push delivery
 *   alive on installed devices.
 * - When notification permission is ALREADY granted, silently refreshes
 *   the push subscription against the signed-in user. Never prompts —
 *   the explicit opt-in lives in PushNotificationsCard.
 *
 * Renders nothing.
 */
export function PwaRegistrar() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reg = await registerServiceWorker();
      if (cancelled || !reg) return;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        await ensurePushSubscription("silent");
      }
    })().catch(() => {
      /* best-effort — PWA wiring must never break a page */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
