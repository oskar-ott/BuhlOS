"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { Calendar, Briefcase, Camera, Wrench, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { PhilCaptureLauncher } from "./PhilCaptureLauncher";
import { captureHref, philJobDetailId } from "./philCapture";

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
    <Link
      href={tab.href}
      aria-current={isActive ? "page" : undefined}
      className="flex flex-1 flex-col items-center justify-center"
    >
      <span className="flex flex-col items-center justify-center gap-0.5">
        <Icon
          aria-hidden="true"
          className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text")}
        />
        <span
          className={cn(
            "text-[11px] uppercase tracking-wider",
            isActive ? "font-semibold text-brand-navy" : "text-text",
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
    </Link>
  );
}

export function PhilTabBar() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [launcherOpen, setLauncherOpen] = useState(false);

  // When the worker is already on a job home, we know the job — capture
  // is a one-tap deep-link. Anywhere else, ask which job (the launcher).
  const currentJobId = philJobDetailId(pathname);
  const onCapture = () => {
    if (currentJobId) {
      // `as Route` — dynamic path string, see PhilCaptureLauncher.
      router.push(captureHref(currentJobId) as Route);
    } else {
      setLauncherOpen(true);
    }
  };

  return (
    <>
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
          >
            <Camera aria-hidden="true" className="h-6 w-6" />
          </button>
          <span className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-brand-navy">
            Capture
          </span>
        </div>

        {RIGHT_TABS.map((tab) => (
          <TabLink key={tab.href} tab={tab} pathname={pathname} />
        ))}
      </nav>

      <PhilCaptureLauncher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
    </>
  );
}
