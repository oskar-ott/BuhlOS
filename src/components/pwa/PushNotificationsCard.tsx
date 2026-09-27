"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ensurePushSubscription, pushSupported, type PushSetupOutcome } from "@/lib/pwa/push";

/**
 * Explicit push-notification opt-in.
 *
 * Replaces the auto-prompt that lived on the deleted legacy my-day.html /
 * admin _shell.js pages — the modern surfaces never beg for permission on
 * load; the user turns reminders on here. Honest states only: every
 * outcome of ensurePushSubscription() is rendered, nothing is faked.
 *
 * Used on /v2/phil (worker hour reminders) and /command-centre (office
 * inbox, digests, overrun alerts).
 */
export function PushNotificationsCard({ audience }: { audience: "phil" | "admin" }) {
  const [state, setState] = useState<"idle" | "working" | PushSetupOutcome>("idle");
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "granted") setGranted(true);
    if (Notification.permission === "denied") setState("denied");
    // Ask the server up front whether push exists at all (the same public-key
    // read ensurePushSubscription does). Unconfigured → the card leaves the
    // screen instead of offering a button that can only end in "tell the
    // office" (P7 — never present an unconfigured channel as working).
    let cancelled = false;
    fetch("/api/notifications?action=public-key", { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) {
          setState("not-configured");
          return;
        }
        if (!res.ok) return; // unknown → keep the button; the tap reports honestly
        const body = (await res.json().catch(() => null)) as { publicKey?: string } | null;
        if (!body?.publicKey) setState("not-configured");
      })
      .catch(() => {
        /* offline / transient — keep the card; the enable tap reports honestly */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onEnable() {
    setState("working");
    const outcome = await ensurePushSubscription("prompt");
    setState(outcome);
    if (outcome === "subscribed") setGranted(true);
  }

  const description =
    audience === "phil"
      ? "Get a nudge to log your hours before knock-off, and a heads-up when your hours are sent back."
      : "Get the end-of-day digest and hours reminders on this device.";

  // Push is a server-configured channel (VAPID keys). When the server says it
  // isn't set up, nothing can ever be sent — so the card renders NOTHING
  // rather than a permanent "tell the office" note on every Command Centre
  // and My Day visit (lean-reset no-trace rule; the owner sees the real
  // state at /owner). Discovered on the first enable attempt; until then the
  // card offers the button as before.
  if (state === "not-configured") return null;

  return (
    <Card className="space-y-3" data-testid="push-notifications-card">
      <div>
        <CardTitle>Notifications</CardTitle>
        <CardDescription className="mt-1">{description}</CardDescription>
      </div>

      {state === "unsupported" ? (
        <p className="text-sm text-text-muted">
          This browser doesn&rsquo;t support push notifications. On iPhone, add the app to your Home
          Screen first, then turn notifications on from there.
        </p>
      ) : state === "denied" ? (
        <p className="text-sm text-text-muted">
          Notifications are blocked for this site. Allow them in your browser settings, then come
          back and tap the button.
        </p>
      ) : state === "subscribed" ? (
        <p className="text-sm font-semibold text-text" role="status">
          Notifications are on for this device.
        </p>
      ) : (
        <div className="space-y-2">
          {state === "failed" ? (
            <p className="text-sm text-text-muted" role="alert">
              That didn&rsquo;t work — check your connection and try again.
            </p>
          ) : null}
          <button
            type="button"
            onClick={onEnable}
            disabled={state === "working"}
            className="inline-flex h-11 items-center justify-center rounded-card bg-accent-yellow px-4 text-sm font-semibold text-brand-navy hover:brightness-95 disabled:opacity-60"
          >
            {state === "working"
              ? "Turning on…"
              : granted
                ? "Refresh notifications on this device"
                : "Turn on notifications"}
          </button>
        </div>
      )}
    </Card>
  );
}
