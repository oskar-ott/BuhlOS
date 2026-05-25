"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Calendar, Briefcase, Wrench, AlertCircle, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

interface Tab {
  label: string;
  href: Route;
  icon: typeof Calendar;
  status: "live" | "under-construction";
  /** Path prefix(es) that mark this tab as active. The first prefix that
   *  the current pathname startsWith() wins. */
  activeFor: ReadonlyArray<string>;
}

/**
 * Phil bottom tabs:
 *   Today  → /phil/my-day  (the hours loop)
 *   Jobs   → /phil/jobs    (jobs + per-job detail + capture + snags)
 *   Gear   → /phil/gear    (my gear: return / report damaged / missing)
 *   Snag   → UC            (cross-job snag inbox lands later)
 *   More   → /v2/phil      (live placeholder; profile menu lands later)
 *
 * UC tabs are visible but non-interactive per
 * docs/architecture/00-rebuild-non-negotiables.md so the worker still
 * sees the roadmap.
 *
 * Active tab is the one whose `activeFor` prefix matches the current
 * pathname (per doc 27 §7.1: "active tab indicator is a brand-yellow
 * dot + label colour change"). Brand-yellow dot lives below the icon.
 */
const TABS: ReadonlyArray<Tab> = [
  { label: "Today", href: "/phil/my-day", icon: Calendar, status: "live", activeFor: ["/phil/my-day"] },
  { label: "Jobs", href: "/phil/jobs", icon: Briefcase, status: "live", activeFor: ["/phil/jobs"] },
  { label: "Gear", href: "/phil/gear", icon: Wrench, status: "live", activeFor: ["/phil/gear"] },
  { label: "Snag", href: "/v2/phil", icon: AlertCircle, status: "under-construction", activeFor: [] },
  { label: "More", href: "/v2/phil", icon: MoreHorizontal, status: "live", activeFor: ["/v2/phil"] },
];

export function PhilTabBar() {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="Phil tabs"
      className="sticky bottom-0 flex h-16 shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab, idx) => {
        const Icon = tab.icon;
        const isLive = tab.status === "live";
        const isActive =
          isLive && tab.activeFor.some((p) => pathname === p || pathname.startsWith(`${p}/`));
        const labelColour = isLive
          ? isActive
            ? "text-brand-navy font-semibold"
            : "text-text"
          : "text-text-muted/60";
        const iconColour = isLive
          ? isActive
            ? "text-brand-navy"
            : "text-text"
          : "text-text-muted/60";
        const content = (
          <span className="flex flex-1 flex-col items-center justify-center gap-0.5">
            <Icon aria-hidden="true" className={cn("h-5 w-5", iconColour)} />
            <span className={cn("flex items-center gap-1 text-[11px] uppercase tracking-wider", labelColour)}>
              {tab.label}
              {!isLive ? (
                <span
                  aria-hidden="true"
                  className="rounded-pill border border-border bg-surface-subtle px-1 text-[9px] font-medium tracking-wider text-text-muted"
                >
                  SOON
                </span>
              ) : null}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "h-1 w-1 rounded-pill",
                isActive ? "bg-accent-yellow" : "bg-transparent"
              )}
            />
          </span>
        );
        return isLive ? (
          <Link
            key={`${tab.label}-${idx}`}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className="flex flex-1 flex-col items-center justify-center"
          >
            {content}
          </Link>
        ) : (
          <span
            key={`${tab.label}-${idx}`}
            aria-disabled="true"
            title={`${tab.label} — still being built`}
            className="flex flex-1 cursor-not-allowed flex-col items-center justify-center"
          >
            {content}
          </span>
        );
      })}
    </nav>
  );
}
