"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Briefcase, ClipboardCheck, LayoutGrid, MoreHorizontal, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { AdminMoreSheet } from "./AdminMoreSheet";

/**
 * BuhlOS admin bottom tab bar — the calm mobile office nav (the audit's
 * "thin boss view", not the desktop Command Centre squeezed onto glass).
 *
 * AdminSidebar is desktop-only (`hidden … md:flex`); below md this 5-item bar
 * is the primary navigation. It mirrors the Phil tab bar (PhilTabBar.tsx) so
 * the two surfaces feel like one product: brand-navy icon + label when active
 * with a 4px accent-yellow dot, text-muted when not.
 *
 * Four tabs are real routes; the fifth — More — opens AdminMoreSheet (the full
 * office IA + Notification settings + sign-out), replacing the old AdminTopbar
 * hamburger. It is a `<button>`, not a `<Link>`, so it carries no route (mirrors
 * the Phil Capture FAB).
 *
 * The tab hrefs are validated by scripts/check-route-ownership.js, which parses
 * the `TAB_ITEMS` array literal below — keep each item one-level with a
 * double-quoted `href`, and keep every href in APPROVED_ADMIN_HREFS.
 *
 * Badges are honest-or-absent (P7): a count renders only when a real, positive
 * value is passed. There is no cheap client-side counts endpoint today, so the
 * shell mounts this without counts; a page that already computes them (e.g.
 * /command-centre) can feed them in future without this component changing.
 */
interface TabItem {
  label: string;
  href: Route;
  icon: typeof LayoutGrid;
  /** Path prefix(es) that mark this tab active. */
  activeFor: ReadonlyArray<string>;
}

const TAB_ITEMS: ReadonlyArray<TabItem> = [
  { label: "Today", href: "/command-centre", icon: LayoutGrid, activeFor: ["/command-centre"] },
  { label: "Jobs", href: "/v2/jobs" as Route, icon: Briefcase, activeFor: ["/v2/jobs"] },
  { label: "Approvals", href: "/hours/approvals" as Route, icon: ClipboardCheck, activeFor: ["/hours"] },
  { label: "People", href: "/employees" as Route, icon: Users, activeFor: ["/employees"] },
];

function isTabActive(tab: TabItem, pathname: string): boolean {
  return tab.activeFor.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

interface AdminMobileTabBarProps {
  /** Optional honest badge counts, rendered only when > 0. */
  badges?: { today?: number; approvals?: number };
  /** #760: owner-disabled feature hrefs — hide the matching primary tab, and
   *  filter the "More" sheet's full IA. Undefined = show everything. */
  hiddenHrefs?: ReadonlyArray<string>;
}

export function AdminMobileTabBar({ badges, hiddenHrefs }: AdminMobileTabBarProps = {}) {
  const pathname = usePathname() ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const hidden = hiddenHrefs && hiddenHrefs.length > 0 ? new Set(hiddenHrefs) : null;
  const tabs = hidden ? TAB_ITEMS.filter((t) => !hidden.has(t.href)) : TAB_ITEMS;
  const badgeFor: Record<string, { n: number; tone: "danger" | "amber" } | undefined> = {
    Today: badges?.today && badges.today > 0 ? { n: badges.today, tone: "danger" } : undefined,
    Approvals:
      badges?.approvals && badges.approvals > 0 ? { n: badges.approvals, tone: "amber" } : undefined,
  };

  return (
    <>
      <nav
        aria-label="BuhlOS tabs"
        className="sticky bottom-0 z-30 flex h-16 shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = isTabActive(tab, pathname);
          const badge = badgeFor[tab.label];
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className="flex flex-1 flex-col items-center justify-center"
            >
              <span className="relative flex flex-col items-center justify-center gap-0.5">
                <span className="relative">
                  <Icon
                    aria-hidden="true"
                    className={cn("h-5 w-5", isActive ? "text-brand-navy" : "text-text-muted")}
                  />
                  {badge ? (
                    <span
                      className={cn(
                        "absolute -right-2.5 -top-1.5 inline-flex min-w-[16px] items-center justify-center rounded-pill px-1 text-[10px] font-bold leading-4 text-text-inverse ring-2 ring-surface",
                        badge.tone === "danger" ? "bg-state-danger" : "bg-accent-yellow !text-brand-navy",
                      )}
                    >
                      {badge.n}
                    </span>
                  ) : null}
                </span>
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
            </Link>
          );
        })}

        {/* More — opens the full office IA + sign-out (a button, not a route). */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          className="flex flex-1 flex-col items-center justify-center"
        >
          <span className="flex flex-col items-center justify-center gap-0.5">
            <MoreHorizontal
              aria-hidden="true"
              className={cn("h-5 w-5", moreOpen ? "text-brand-navy" : "text-text-muted")}
            />
            <span
              className={cn(
                "text-[12px] uppercase tracking-wider",
                moreOpen ? "font-semibold text-brand-navy" : "font-medium text-text-muted",
              )}
            >
              More
            </span>
            <span aria-hidden="true" className="h-1 w-1 rounded-pill bg-transparent" />
          </span>
        </button>
      </nav>

      <AdminMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} hiddenHrefs={hiddenHrefs} />
    </>
  );
}
