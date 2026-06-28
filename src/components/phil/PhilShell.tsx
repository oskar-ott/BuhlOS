import type { ReactNode } from "react";
import { PhilHeader } from "./PhilHeader";
import { PhilTabBar } from "./PhilTabBar";
import { CaptureLauncherProvider } from "./captureLauncherContext";
import { PhilOfflineBanner } from "./PhilOfflineBanner";
import { PullToRefresh } from "./PullToRefresh";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";

interface PhilShellProps {
  children: ReactNode;
  title: string;
  /**
   * The signed-in worker's id, threaded to the tab bar so the FAB long-press
   * recents (#146) key to #145's per-worker prefs. Optional: pages that don't
   * pass it (e.g. loading skeletons) simply get a FAB with no recents — the
   * plain camera tap is unaffected.
   */
  userId?: string;
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
export function PhilShell({ children, title, userId }: PhilShellProps) {
  return (
    <div
      data-testid="phil-shell"
      className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface"
    >
      <PhilHeader title={title} />
      {/* The provider lets in-page quick-action tiles open the global Capture
          launcher (mounted inside PhilTabBar) preset to one action. Wraps both
          the content and the tab bar so the request flows from a tile to the
          launcher. */}
      <CaptureLauncherProvider>
        {/* Subtle-grey content surface so the white `surface-raised` cards
            lift off the page instead of blending into a flat-white shell.
            PullToRefresh owns the single shared scroll container (#149) so every
            Phil screen inherits pull-to-refresh; <main> is just the landmark. */}
        <main className="flex min-h-0 flex-1 flex-col">
          <PullToRefresh>
            <PhilOfflineBanner />
            {children}
          </PullToRefresh>
        </main>
        <PhilTabBar userId={userId} />
      </CaptureLauncherProvider>
      <PwaRegistrar />
    </div>
  );
}
