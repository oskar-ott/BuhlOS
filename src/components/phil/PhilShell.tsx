import type { ReactNode } from "react";
import { PhilHeader } from "./PhilHeader";
import { PhilTabBar } from "./PhilTabBar";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";

interface PhilShellProps {
  children: ReactNode;
  title: string;
}

/**
 * Mobile-first Phil shell. Since the legacy-interface cutover this IS the
 * field surface — the legacy public/phil.html / my-day.html pages are gone
 * and their URLs redirect here.
 *
 * PwaRegistrar keeps the installed-PWA story alive post-cutover: it
 * registers /sw.js (Web Push delivery + legacy-cache purge) and, when
 * notification permission is already granted, silently refreshes the
 * push subscription so crews migrating from the legacy pages keep their
 * hour reminders without re-opting-in.
 */
export function PhilShell({ children, title }: PhilShellProps) {
  return (
    <div
      data-testid="phil-shell"
      className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface"
    >
      <PhilHeader title={title} />
      {/* Subtle-grey content surface so the white `surface-raised` cards
          lift off the page instead of blending into a flat-white shell. */}
      <main className="flex-1 overflow-y-auto bg-surface-subtle px-4 py-4">{children}</main>
      <PhilTabBar />
      <PwaRegistrar />
    </div>
  );
}
