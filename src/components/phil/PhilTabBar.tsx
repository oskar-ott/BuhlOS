"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Calendar, Briefcase, Wrench, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilCaptureLauncher, type IncomingCapturePhoto } from "./PhilCaptureLauncher";
import { philJobDetailId } from "./philCapture";
import { useCaptureLauncher, type QuickCaptureRequest } from "./captureLauncherContext";

interface Tab {
  label: string;
  href: Route;
  icon: typeof Calendar;
  /** Path prefix(es) that mark this tab as active. */
  activeFor: ReadonlyArray<string>;
}

/**
 * Phil bottom tabs — a 4-tab + centre Capture FAB layout:
 *
 *   Today  → /phil/my-day  (the hours loop)
 *   Jobs   → /phil/jobs    (jobs + per-job detail)
 *   [FAB]  → Capture       (global capture launcher — opens from anywhere)
 *   Gear   → /phil/gear    (my gear: return / report damaged / missing)
 *   More   → /v2/phil      (profile menu lands later)
 *
 * The centre Capture FAB replaces the old non-working "Snag" UC tab.
 * Capture is the universal field action: a worker can start a photo
 * capture from Today or Gear in one or two taps rather than opening a
 * job and scrolling to the mid-page Capture block. The launcher routes
 * to the existing, fully-wired CaptureSheet — no new persistence path.
 *
 * Active tab indicator (doc 27 §7.1): brand-yellow dot below the icon +
 * label colour change.
 */
const LEFT_TABS: ReadonlyArray<Tab> = [
  { label: "Today", href: "/phil/my-day", icon: Calendar, activeFor: ["/phil/my-day"] },
  { label: "Jobs", href: "/phil/jobs", icon: Briefcase, activeFor: ["/phil/jobs"] },
];

const RIGHT_TABS: ReadonlyArray<Tab> = [
  { label: "Gear", href: "/phil/gear", icon: Wrench, activeFor: ["/phil/gear"] },
  { label: "More", href: "/v2/phil", icon: MoreHorizontal, activeFor: ["/v2/phil"] },
];

function isTabActive(tab: Tab, pathname: string): boolean {
  return tab.activeFor.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function TabLink({ tab, pathname }: { tab: Tab; pathname: string }) {
  const Icon = tab.icon;
  const isActive = isTabActive(tab, pathname);
  return (
    <PhilOfflineLink
      href={tab.href}
      aria-current={isActive ? "page" : undefined}
      className="flex flex-1 flex-col items-center justify-center"
    >
      <span className="flex flex-col items-center justify-center gap-0.5">
        <Icon
          aria-hidden="true"
          className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text-muted")}
        />
        <span
          className={cn(
            "text-[12px] uppercase tracking-wider",
            isActive ? "font-semibold text-brand-navy" : "font-medium text-text-muted",
          )}
        >
          {tab.label}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "h-1 w-1 rounded-pill",
            isActive ? "bg-accent-yellow" : "bg-transparent",
          )}
        />
      </span>
    </PhilOfflineLink>
  );
}

export function PhilTabBar() {
  const pathname = usePathname() ?? "";
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [incoming, setIncoming] = useState<IncomingCapturePhoto | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // A My Day quick-action tile (or any screen) can ask the global launcher to
  // open preset to one action. The FAB path leaves quickAction null, so the
  // camera-first flow is unchanged.
  const { request, clearRequest } = useCaptureLauncher();
  const [quickRequest, setQuickRequest] = useState<QuickCaptureRequest | null>(null);
  const handledSeqRef = useRef(0);
  useEffect(() => {
    if (request && request.seq !== handledSeqRef.current) {
      handledSeqRef.current = request.seq;
      setQuickRequest(request);
      setLauncherOpen(true);
    }
  }, [request]);

  // Camera-first: the FAB fires the OS camera in the SAME tap (the input
  // click must stay inside the user-gesture call stack — iOS blocks deferred
  // programmatic file-input clicks) and opens the launcher behind it to
  // receive the shot. Cancelling the camera just leaves the launcher open
  // with its photo button + "log something" options. On a job home the
  // launcher preselects that job as the destination.
  const currentJobId = philJobDetailId(pathname);
  const fireCamera = () => cameraInputRef.current?.click();
  const onCapture = () => {
    fireCamera();
    setLauncherOpen(true);
  };
  const onCameraChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so the same photo can be re-taken back-to-back.
    e.target.value = "";
    if (!file) return;
    seqRef.current += 1;
    setIncoming({ file, seq: seqRef.current });
  };

  return (
    <>
      {/* Always-mounted global camera input — the single source of camera
          shots for the capture launcher (first shot from the FAB tap, repeat
          shots via the launcher's "Add photo"). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={onCameraChange}
      />
      <nav
        aria-label="Phil tabs"
        className="sticky bottom-0 flex h-16 shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
      >
        {LEFT_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}

        {/* Centre Capture button — the universal field action, present on
            every Phil screen. Lifted above the bar so it reads as primary. */}
        <div className="flex flex-1 flex-col items-center justify-end pb-1">
          <button
            type="button"
            aria-label="Capture"
            aria-haspopup={currentJobId ? undefined : "dialog"}
            onClick={onCapture}
            className={cn(
              "-mt-6 inline-flex h-14 w-14 items-center justify-center rounded-full",
              "border-4 border-surface bg-accent-yellow text-brand-navy shadow-raised",
              "transition-transform active:scale-95",
            )}
          />
          <span className="mt-0.5 text-[12px] font-semibold uppercase tracking-wider text-brand-navy">
            Capture
          </span>
        </div>

        {RIGHT_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}
      </nav>

      <PhilCaptureLauncher
        open={launcherOpen}
        onClose={() => {
          setLauncherOpen(false);
          setQuickRequest(null);
          clearRequest();
        }}
        initialJobId={currentJobId}
        incoming={incoming}
        onRequestCamera={fireCamera}
        initialAction={quickRequest?.action ?? null}
        actionSeq={quickRequest?.seq ?? 0}
      />
    </>
  );
}
