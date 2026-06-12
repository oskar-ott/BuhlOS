"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import {
  LayoutGrid,
  Calculator,
  ClipboardList,
  Inbox,
  BarChart3,
  Briefcase,
  Bug,
  Package,
  Clock,
  Wrench,
  Users,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { SignOutButton } from "./SignOutButton";

interface NavItem {
  label: string;
  href: Route;
  icon: typeof LayoutGrid;
  /** Path prefix(es) that mark this item active; longest prefix wins
   *  (so a deeper sibling entry would beat /hours on its own pages). */
  activeFor: ReadonlyArray<string>;
}

interface NavGroup {
  heading: string;
  items: ReadonlyArray<NavItem>;
}

/**
 * BuhlOS admin nav (#187) — ONE grouped mental model.
 *
 * History: this list once carried three non-clickable "under construction"
 * stubs and the plan was to bridge ~20 legacy modules. The legacy cutover
 * (#376) deleted that estate — every legacy URL 307s to a v2 surface — so
 * the two-world bridge collapsed into what's below: every LIVE production
 * surface, grouped by how the office thinks, and nothing dead (the
 * hide-unfinished rule: an unclickable nav item is a broken promise).
 *
 * Keep this list aligned with
 * docs/rebuild-audit/13-ui-information-architecture.md
 * §"BuhlOS Admin information architecture > Left sidebar sections" —
 * that doc is the source of truth for the IA.
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    heading: "Today",
    items: [
      {
        label: "Command centre",
        href: "/command-centre",
        icon: LayoutGrid,
        activeFor: ["/command-centre"],
      },
      {
        label: "Observations",
        href: "/observations" as Route,
        icon: Inbox,
        activeFor: ["/observations"],
      },
      {
        label: "Material requests",
        href: "/material-requests" as Route,
        icon: Package,
        activeFor: ["/material-requests"],
      },
    ],
  },
  {
    heading: "Jobs",
    items: [
      {
        label: "Jobs",
        href: "/v2/jobs" as Route,
        icon: Briefcase,
        activeFor: ["/v2/jobs"],
      },
      {
        // v2 quote builder foundation (#183) — quotes are where jobs are
        // born (#120/WS2), so they live in the Jobs group.
        label: "Quotes",
        href: "/v2/quotes" as Route,
        icon: Calculator,
        activeFor: ["/v2/quotes"],
      },
      {
        // Cross-job defects register (#414) — doc 13 reserves this slot.
        label: "Defects",
        href: "/defects" as Route,
        icon: Bug,
        activeFor: ["/defects"],
      },
      {
        label: "ITP templates",
        href: "/itp-templates" as Route,
        icon: ClipboardList,
        activeFor: ["/itp-templates"],
      },
    ],
  },
  {
    heading: "Hours",
    items: [
      // ONE item for the whole hours workflow (#415) — Day, Approvals and
      // Weekly closeout are in-page tabs (HoursTabs) on /hours/*, not
      // sidebar entries. The /hours prefix keeps this item active across
      // all three routes.
      {
        label: "Hours",
        href: "/hours",
        icon: Clock,
        activeFor: ["/hours"],
      },
    ],
  },
  {
    heading: "People & gear",
    items: [
      {
        label: "Employees",
        href: "/employees" as Route,
        icon: Users,
        activeFor: ["/employees"],
      },
      {
        label: "Gear",
        href: "/gear",
        icon: Wrench,
        activeFor: ["/gear"],
      },
    ],
  },
  {
    heading: "Company",
    items: [
      {
        // #316 — the six numbers the owner checks daily (doc 13 names
        // this section "Reports"). Numbers + trends live here; queues
        // stay on /command-centre.
        label: "Reports",
        href: "/reports" as Route,
        icon: BarChart3,
        activeFor: ["/reports"],
      },
    ],
  },
];

const ALL_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The active item is the one whose `activeFor` prefix is the LONGEST match
 * for the pathname. With the hours section collapsed to one entry (#415)
 * the /hours prefix alone keeps it active on /hours, /hours/approvals and
 * /hours/weekly; the longest-prefix rule stays so a future deeper entry
 * (e.g. a dedicated sub-route item) would win over its section root again.
 */
function activeHref(pathname: string): string | null {
  let best: string | null = null;
  let bestPrefixLen = -1;
  for (const item of ALL_ITEMS) {
    for (const prefix of item.activeFor) {
      const match = pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (match && prefix.length > bestPrefixLen) {
        best = item.href;
        bestPrefixLen = prefix.length;
      }
    }
  }
  return best;
}

export function AdminSidebar() {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-brand-navy text-text-inverse md:flex">
      <div className="px-5 py-6">
        <p className="font-display text-xs uppercase tracking-widest text-accent-yellow">BuhlOS</p>
        <p className="font-display text-base text-text-inverse">Command Centre</p>
      </div>

      <nav aria-label="BuhlOS admin" className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="mb-3">
            <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-widest text-slate-400">
              {group.heading}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        // Per doc 27 §7.2: active = yellow left border +
                        // accent-ink background + semi-bold label.
                        "group flex items-center gap-3 rounded-card border-l-2 px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "border-l-accent-yellow bg-accent-ink font-semibold text-text-inverse"
                          : "border-l-transparent text-text-inverse hover:bg-accent-ink/60",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-accent-ink p-3">
        {/* Settings is not a daily destination, so it lives in the footer next
            to sign-out rather than as a nav-group item (#218). Today it is the
            notification-prefs page only; #222 grows /settings into a hub. */}
        <Link
          href={"/settings/notifications" as Route}
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings")
              ? "bg-accent-ink font-semibold text-text-inverse"
              : "text-slate-300 hover:bg-accent-ink hover:text-text-inverse",
          )}
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
          <span className="flex-1 truncate">Notification settings</span>
        </Link>
        <SignOutButton />
      </div>
    </aside>
  );
}
