import type { ReactNode } from "react";
import { PhilHeader } from "./PhilHeader";
import { PhilTabBar } from "./PhilTabBar";
import { CaptureLauncherProvider } from "./captureLauncherContext";
import { PhilSharpenedProvider } from "./philSharpenedContext";
import { PhilJobRoomsBarProvider } from "./philJobRoomsBar";
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
  /**
   * phil_sharpened (dark): the field-surface redesign's global chrome —
   * 5-slot tab bar (Today · Jobs · [Capture] · Hours · Gear) + the header
   * account avatar. Resolve SERVER-SIDE via philSharpenedFlags()
   * (src/lib/phil/sharpened.ts) and pass the boolean; never the flags blob.
   * False/absent = today's chrome, byte-identical.
   */
  sharpened?: boolean;
  /** Worker initials for the sharpened header avatar (optional, honest-null). */
  accountInitials?: string | null;
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
export function PhilShell({
  children,
  title,
  userId,
  sharpened = false,
  accountInitials = null,
}: PhilShellProps) {
  return (
    <div
      data-testid="phil-shell"
      className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface"
    >
      <PhilHeader title={title} sharpened={sharpened} accountInitials={accountInitials} />
      {/* The providers let in-page quick-action tiles open the global Capture
          launcher (mounted inside PhilTabBar) preset to one action, and carry
          the server-resolved phil_sharpened boolean to the launcher (which is
          mounted by PhilTabBar, not a page). Both wrap the content AND the tab
          bar so requests/flags flow from a tile to the launcher. */}
      <PhilSharpenedProvider sharpened={sharpened}>
      <CaptureLauncherProvider>
        {/* Rooms-bar bridge (phil_job_rooms, dark): lets a job screen rebind the
            tab bar's flanking slots to its in-job rooms. Renders no DOM; with
            nothing registered (every screen today) the bar is byte-identical. */}
        <PhilJobRoomsBarProvider>
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
          <PhilTabBar userId={userId} sharpened={sharpened} />
        </PhilJobRoomsBarProvider>
      </CaptureLauncherProvider>
      </PhilSharpenedProvider>
      <PwaRegistrar />
    </div>
  );
}
