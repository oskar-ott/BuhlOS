"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface HoursTab {
  label: string;
  href: Route;
  /** /hours is the section root — exact match only, so the Day tab never
   *  stays lit on the deeper routes; the others match by prefix. */
  exact?: boolean;
}

/**
 * Lean-reset redesign: three visible tabs — Today · This week · Pay period.
 * The Approvals ROUTE stays fully live (deep links, the Today page's
 * "Review N pending" CTA and the mobile tab bar all still land on
 * /hours/approvals) — it just no longer occupies a tab slot; the day-by-day
 * queue is a drill-in from Today rather than a sibling surface.
 */
const TABS: ReadonlyArray<HoursTab> = [
  { label: "Today", href: "/hours", exact: true },
  // `as Route` — typedRoutes' generated map is from the previous build
  // (same pattern as AdminSidebar's newer entries); validated by `next build`.
  { label: "This week", href: "/hours/weekly" as Route },
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
 *
 * #669 — scroll affordance for small phones. The strip already scrolls
 * horizontally (#660, overflow-x-auto) when the 4 labels overflow ≤375px, but
 * nothing told the operator there was more off-screen. Two decorative edge
 * fades (phones only, md:hidden) sit over the clipped edges, shown ONLY when
 * there is actually hidden content that side (measured client-side) — an
 * honest cue, never a fade implying tabs that aren't there (P7). The active
 * tab is also scrolled into view, so deep-linking to "Pay period" on a phone
 * doesn't land on a strip that looks like it starts at "Day". Both behaviours
 * are client-only (refs/effects are inert under SSR), so the markup the server
 * sends — and the SSR test — is unchanged bar the new scroll-target testid.
 */
export function HoursTabs() {
  const pathname = usePathname() ?? "";
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);
  // SSR-safe defaults: no fade until we've measured on the client (honest —
  // we don't claim hidden content before we know there is any).
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  // Measure on mount, on horizontal scroll, and on resize (a rotate/keyboard
  // can change which tabs fit). Listeners cleaned up on unmount.
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // Keep the active tab in view (e.g. a push deep-link to /hours/period on a
  // narrow phone). `nearest` never scrolls when it's already visible — and
  // never moves the page vertically.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    measure();
  }, [pathname, measure]);

  return (
    <nav
      aria-label="Hours sections"
      data-testid="hours-tabs"
      className="mx-auto mb-4 max-w-4xl border-b border-border"
    >
      <div className="relative">
        {/* Decorative edge fades — phones only (md:hidden), shown only when
            there's genuinely hidden content that side. The strip sits on the
            AdminShell's bg-surface-subtle, so the gradient fades from that. */}
        {canScrollLeft ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-surface-subtle to-transparent md:hidden"
          />
        ) : null}
        {canScrollRight ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-surface-subtle to-transparent md:hidden"
          />
        ) : null}
        {/* Scrollable on phones: the 4 labels (incl. "Weekly closeout",
            "Pay period") overflow ≤375px, so the strip scrolls horizontally
            rather than clipping tabs off-screen. Desktop shows no scrollbar. */}
        <ul
          ref={scrollRef}
          data-testid="hours-tabs-scroll"
          className="-mb-px flex items-end gap-1 overflow-x-auto"
        >
          {TABS.map((tab) => {
            const active = isActiveTab(pathname, tab);
            return (
              <li key={tab.href} ref={active ? activeRef : undefined} className="shrink-0">
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    // Active = accent treatment + semibold, the sidebar's
                    // active convention (doc 27 §7.2) turned on its side:
                    // yellow bottom border instead of left border. py-3 +
                    // text-sm ≈ a 44px hit area.
                    "inline-flex items-center whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy",
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
      </div>
    </nav>
  );
}
