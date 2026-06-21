"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { cn } from "@/lib/cn";

interface HoursTab {
  label: string;
  href: Route;
  /** /hours is the section root — exact match only, so the Day tab never
   *  stays lit on the deeper routes; the others match by prefix. */
  exact?: boolean;
}

const TABS: ReadonlyArray<HoursTab> = [
  { label: "Day", href: "/hours", exact: true },
  { label: "Approvals", href: "/hours/approvals" },
  // `as Route` — typedRoutes' generated map is from the previous build
  // (same pattern as AdminSidebar's newer entries); validated by `next build`.
  { label: "Weekly closeout", href: "/hours/weekly" as Route },
  { label: "Pay period", href: "/hours/period" as Route },
];

function isActiveTab(pathname: string, tab: HoursTab): boolean {
  if (tab.exact) return pathname === tab.href;
  return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
}

/**
 * In-page tab bar for the hours section — issue #415.
 *
 * The sidebar shows ONE "Hours" item (active across all three routes via its
 * /hours prefix); this bar is how the operator moves between the section's
 * three surfaces: the day view, the approval queue and the weekly closeout
 * board. Plain <Link>s to the SAME sacred URLs — no route changes, so every
 * existing deep link (push notifications included) keeps working.
 *
 * Active state is derived LIVE from usePathname() — never snapshotted into
 * useState — so client-side navigation between the tabs always re-renders
 * the correct active tab (the soft-nav pitfall, #116→#118).
 *
 * Mounted per-page as the first child inside each page's <AdminShell> (not
 * in hours/layout.tsx): AdminShell is applied per-page with per-page titles,
 * so a layout-mounted bar would render OUTSIDE the shell's main column.
 *
 * The wrapper carries the same mx-auto/max-w-4xl column as the three pages'
 * content so the tabs align with what they switch between.
 */
export function HoursTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Hours sections"
      data-testid="hours-tabs"
      className="mx-auto mb-4 max-w-4xl border-b border-border"
    >
      <ul className="-mb-px flex items-end gap-1">
        {TABS.map((tab) => {
          const active = isActiveTab(pathname, tab);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // Active = accent treatment + semibold, the sidebar's
                  // active convention (doc 27 §7.2) turned on its side:
                  // yellow bottom border instead of left border. py-3 +
                  // text-sm ≈ a 44px hit area.
                  "inline-flex items-center border-b-2 px-4 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy",
                  active
                    ? "border-accent-yellow font-semibold text-text"
                    : "border-transparent text-text-muted hover:border-border hover:text-text",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
