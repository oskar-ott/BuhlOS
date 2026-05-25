"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import {
  LayoutGrid,
  ClipboardCheck,
  AlertOctagon,
  LifeBuoy,
  Briefcase,
  Settings,
  Clock,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Pill } from "@/components/ui/Pill";
import { SignOutButton } from "./SignOutButton";

interface NavItem {
  label: string;
  href: Route;
  icon: typeof LayoutGrid;
  status: "live" | "under-construction";
  /** Path prefix(es) that mark this item as the active section. The
   *  first prefix that the current pathname startsWith() wins. Approvals
   *  is more-specific than Hours, so it must appear earlier in NAV (the
   *  first match wins via the for-loop in `activeIndex`). */
  activeFor: ReadonlyArray<string>;
}

/**
 * BuhlOS admin nav.
 *
 * Live items: Command centre · Hours · Approvals · Gear · Jobs.
 * UC items (still being built):
 *   - Snags (cross-job triage queue — per-job snags live on the Jobs
 *     surface today).
 *   - Support · Settings.
 *
 * Per doc 27 §7.2: active section gets a brand-yellow left border +
 * accent-ink (darker navy) background + semi-bold label. UC items are
 * non-clickable per non-negotiable §"Feature gating".
 *
 * Keep this list aligned with docs/rebuild-audit/13-ui-information-architecture.md
 * §"BuhlOS Admin information architecture > Left sidebar sections".
 */
const NAV: ReadonlyArray<NavItem> = [
  {
    label: "Command centre",
    href: "/command-centre",
    icon: LayoutGrid,
    status: "live",
    activeFor: ["/command-centre"],
  },
  // Approvals must appear before Hours so its more-specific prefix wins
  // when the pathname is /hours/approvals.
  {
    label: "Hours",
    href: "/hours",
    icon: Clock,
    status: "live",
    activeFor: ["/hours"],
  },
  {
    label: "Approvals",
    href: "/hours/approvals",
    icon: ClipboardCheck,
    status: "live",
    activeFor: ["/hours/approvals"],
  },
  {
    label: "Gear",
    href: "/gear",
    icon: Wrench,
    status: "live",
    activeFor: ["/gear"],
  },
  // `/v2/jobs` is the rebuild jobs index; the `as Route` cast keeps tsc
  // happy until the next build regenerates the typed-route union.
  {
    label: "Jobs",
    href: "/v2/jobs" as Route,
    icon: Briefcase,
    status: "live",
    activeFor: ["/v2/jobs"],
  },
  {
    label: "Snags",
    href: "/command-centre",
    icon: AlertOctagon,
    status: "under-construction",
    activeFor: [],
  },
  {
    label: "Support",
    href: "/command-centre",
    icon: LifeBuoy,
    status: "under-construction",
    activeFor: [],
  },
  {
    label: "Settings",
    href: "/command-centre",
    icon: Settings,
    status: "under-construction",
    activeFor: [],
  },
];

/**
 * Pick the active item by choosing the live item whose `activeFor`
 * prefix is the longest match for the current pathname. This handles
 * the /hours vs /hours/approvals case naturally — Approvals wins on
 * /hours/approvals because its prefix is longer, Hours wins on /hours
 * because Approvals' prefix doesn't match.
 */
function activeIndex(pathname: string): number {
  let bestIdx = -1;
  let bestPrefixLen = -1;
  for (let i = 0; i < NAV.length; i += 1) {
    const item = NAV[i]!;
    if (item.status !== "live") continue;
    for (const prefix of item.activeFor) {
      const match =
        pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (match && prefix.length > bestPrefixLen) {
        bestIdx = i;
        bestPrefixLen = prefix.length;
      }
    }
  }
  return bestIdx;
}

export function AdminSidebar() {
  const pathname = usePathname() ?? "";
  const active = activeIndex(pathname);

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-brand-navy text-text-inverse md:flex">
      <div className="px-5 py-6">
        <p className="font-display text-xs uppercase tracking-widest text-accent-yellow">BuhlOS</p>
        <p className="font-display text-base text-text-inverse">Command Centre</p>
      </div>

      <nav aria-label="BuhlOS admin" className="flex-1 px-2">
        <ul className="space-y-1">
          {NAV.map((item, idx) => {
            const Icon = item.icon;
            const isLive = item.status === "live";
            const isActive = isLive && idx === active;
            // Per doc 27 §7.2: active section = yellow left border +
            // accent-ink background + semi-bold label. The default
            // sidebar background is already brand-navy, so accent-ink
            // (darker shade) gives the contrast pop. Inactive live
            // items keep the existing hover-only treatment.
            const baseClass = cn(
              "group flex items-center gap-3 rounded-card border-l-2 px-3 py-2 text-sm transition-colors",
              isLive
                ? isActive
                  ? "border-l-accent-yellow bg-accent-ink font-semibold text-text-inverse"
                  : "border-l-transparent text-text-inverse hover:bg-accent-ink/60"
                : "border-l-transparent cursor-not-allowed text-slate-400"
            );
            const isActiveFlag = isActive ? "page" : undefined;
            const content = (
              <>
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
                {!isLive ? (
                  <Pill tone="yellow" className="text-[10px] uppercase tracking-wider">
                    UC
                  </Pill>
                ) : null}
              </>
            );
            return (
              <li key={`${item.label}-${idx}`}>
                {isLive ? (
                  <Link
                    href={item.href}
                    aria-current={isActiveFlag}
                    className={baseClass}
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    title={`${item.label} — still being built`}
                    className={baseClass}
                  >
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-accent-ink p-3">
        <SignOutButton />
      </div>
    </aside>
  );
}
