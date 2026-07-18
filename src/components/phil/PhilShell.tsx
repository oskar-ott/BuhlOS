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
   * False = today's chrome, byte-identical. `undefined` (a flag-less render —
   * the `loading.tsx` skeletons) passes through untouched: the client chrome
   * components fall back to the last server-confirmed value POST-MOUNT
   * (philChromeMemory.ts) so navigations don't flash the ratified chrome.
   */
  sharpened?: boolean;
  /**
   * Worker initials for the sharpened header avatar. Pass a resolved value —
   * including an explicit null (honest "no name known") — whenever the page
   * resolved a session; `undefined` means "not resolved here" and the header
   * falls back to the remembered initials post-mount.
   */
  accountInitials?: string | null;
  /**
   * rfi_register, resolved server-side with the phil flags (philSharpenedFlags):
   * whether the sharpened Capture sheet may offer the RFI purpose chip. The
   * field raise 404s while the register is off, so a rendered chip would be a
   * dead selection (P7). False/absent = no chip; only meaningful with
   * `sharpened` on.
   */
  rfiRegister?: boolean;
  /**
   * phil_job_rooms, resolved server-side by the JOB page only: the four-rooms
   * takeover WILL bind to the tab bar on this route, so the bar renders the
   * ROOM slots from the first paint (no badges yet) instead of flashing the
   * global tabs until the client binding hydrates — a tap on Hours/Gear in
   * that window would exit the job (#133 criterion polish). False/absent
   * (every other route, and flag off) = the bar behaves exactly as before;
   * `undefined` lets the bar consult the chrome memory post-mount (the job
   * loading skeleton keeps the room bar — #133 mis-tap).
   */
  roomsActive?: boolean;
  /**
   * The viewer's phil_job_rooms flag, forwarded to PhilTabBar purely to warm
   * the chrome memory from NON-job pages (they resolve philSharpenedFlags
   * anyway) — never changes this render.
   */
  jobRoomsEnabled?: boolean;
  /**
   * observations_inbox, resolved SERVER-SIDE by the page (isFlagEnabled) and
   * passed as a boolean: whether the global Capture launcher may offer the
   * worker/office observation options ("log something", "send to the office",
   * the My Day quick-action presets). Their writes go to /api/observations,
   * which 404s while the flag is off — so with it off the launcher shows ONLY
   * the photo/evidence path. Defaults FALSE (safe-by-dark): an unthreaded
   * call site (loading skeletons) never shows a dead observation form.
   */
  observationsEnabled?: boolean;
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
  sharpened,
  accountInitials,
  rfiRegister,
  roomsActive,
  jobRoomsEnabled,
  observationsEnabled = false,
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
      <PhilSharpenedProvider sharpened={sharpened} rfiRegister={rfiRegister}>
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
          <PhilTabBar
            userId={userId}
            sharpened={sharpened}
            roomsActive={roomsActive}
            jobRoomsEnabled={jobRoomsEnabled}
            observationsEnabled={observationsEnabled}
          />
        </PhilJobRoomsBarProvider>
      </CaptureLauncherProvider>
      </PhilSharpenedProvider>
      <PwaRegistrar />
    </div>
  );
}
