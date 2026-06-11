"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import {
  ensurePushSubscription,
  pushSupported,
  type PushSetupOutcome,
} from "@/lib/pwa/push";

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
  }, []);

  async function onEnable() {
    setState("working");
    const outcome = await ensurePushSubscription("prompt");
    setState(outcome);
    if (outcome === "subscribed") setGranted(true);
  }

  const description =
    audience === "phil"
      ? "Get a nudge to log your hours before knock-off, and a heads-up when a job or snag is assigned to you."
      : "Get the end-of-day digest, office-inbox items, stale-snag and job-overrun alerts on this device.";

  return (
    <Card className="space-y-3" data-testid="push-notifications-card">
      <div>
        <CardTitle>Notifications</CardTitle>
        <CardDescription className="mt-1">{description}</CardDescription>
      </div>

      {state === "unsupported" ? (
        <p className="text-sm text-text-muted">
          This browser doesn&rsquo;t support push notifications. On iPhone, add the app to your
          Home Screen first, then turn notifications on from there.
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
      ) : state === "not-configured" ? (
        <p className="text-sm text-text-muted">
          Push isn&rsquo;t configured on the server yet, so nothing can be sent. Tell the office.
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
