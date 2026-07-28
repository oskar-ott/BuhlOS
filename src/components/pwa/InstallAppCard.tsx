"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * "Put BuhlOS on your home screen" — the install instructions card.
 *
 * The welcome email tells a new worker to add the app to their home screen;
 * this card is where the app itself shows them HOW. Lives on the More tab
 * next to PushNotificationsCard (iPhone push needs the installed app first,
 * so install comes before notifications).
 *
 * Honest states only:
 *  - already running installed (standalone) → renders nothing, the job's done
 *  - Android/Chrome with a captured beforeinstallprompt → a real install
 *    button that triggers the browser's own prompt
 *  - otherwise → the manual steps for the platform we detect (iPhone gets
 *    the Safari Share path; everything else gets the browser-menu path)
 */

type Platform = "ios" | "android" | "other";

// Chrome-family install prompt event — not in the TS DOM lib.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

// Shared with the signup flow's home-screen step — one source for the
// install instructions, so the copy can't drift between surfaces.
export const IOS_INSTALL_STEPS: ReadonlyArray<React.ReactNode> = [
  <>
    Open <span className="font-semibold">buhlos.com</span> in{" "}
    <span className="font-semibold">Safari</span> (this won&rsquo;t work from another
    browser or the group chat).
  </>,
  <>
    Tap the <span className="font-semibold">Share</span> button — the square with the
    arrow pointing up.
  </>,
  <>
    Scroll down and tap <span className="font-semibold">Add to Home Screen</span>, then{" "}
    <span className="font-semibold">Add</span>.
  </>,
];

export const ANDROID_INSTALL_STEPS: ReadonlyArray<React.ReactNode> = [
  <>
    Open <span className="font-semibold">buhlos.com</span> in{" "}
    <span className="font-semibold">Chrome</span>.
  </>,
  <>
    Tap the <span className="font-semibold">⋮ menu</span> (top right).
  </>,
  <>
    Tap <span className="font-semibold">Add to Home screen</span> (some phones say{" "}
    <span className="font-semibold">Install app</span>).
  </>,
];

export function StepList({ steps }: { steps: ReadonlyArray<React.ReactNode> }) {
  return (
    <ol className="space-y-1.5 text-sm text-text">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-navy font-display text-[12px] font-bold leading-none text-white"
          >
            {i + 1}
          </span>
          <span className="min-w-0">{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function InstallAppCard() {
  const [platform, setPlatform] = useState<Platform>("other");
  const [hidden, setHidden] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setHidden(true);
      return;
    }
    setPlatform(detectPlatform());

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden) return null;

  async function onInstall() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallEvent(null);
  }

  return (
    <Card className="space-y-3" data-testid="install-app-card">
      <div>
        <CardTitle>Put BuhlOS on your home screen</CardTitle>
        <CardDescription className="mt-1">
          One tap from the ute — no hunting through the browser. On iPhone it&rsquo;s also
          how notifications work.
        </CardDescription>
      </div>

      {installed ? (
        <p className="text-sm font-semibold text-text" role="status">
          Done — BuhlOS is on your home screen. Open it from there from now on.
        </p>
      ) : installEvent ? (
        <button
          type="button"
          onClick={onInstall}
          className="inline-flex h-11 items-center justify-center rounded-card bg-accent-yellow px-4 text-sm font-semibold text-brand-navy hover:brightness-95"
          data-testid="install-app-button"
        >
          Add to home screen
        </button>
      ) : platform === "ios" ? (
        <div className="space-y-2">
          <StepList steps={IOS_INSTALL_STEPS} />
        </div>
      ) : (
        <StepList steps={ANDROID_INSTALL_STEPS} />
      )}
    </Card>
  );
}
