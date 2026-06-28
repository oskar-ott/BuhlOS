import {
  LayoutGrid,
  Calculator,
  ClipboardList,
  ClipboardCheck,
  Inbox,
  BarChart3,
  Briefcase,
  Bug,
  Package,
  Clock,
  Wrench,
  Users,
  Receipt,
  Wallet,
} from "lucide-react";
import type { Route } from "next";

/**
 * BuhlOS admin navigation — the single source of truth for the office IA.
 *
 * Extracted from AdminSidebar (#215) so two surfaces render from ONE list and
 * never drift: the sidebar (its grouped links + longest-prefix active state)
 * and the ⌘K command palette's "Go to" group. Editing a destination here moves
 * both at once.
 *
 * History: this list once carried three non-clickable "under construction"
 * stubs and the plan was to bridge ~20 legacy modules. The legacy cutover
 * (#376) deleted that estate — every legacy URL 307s to a v2 surface — so the
 * two-world bridge collapsed into what's below: every LIVE production surface,
 * grouped by how the office thinks, and nothing dead (the hide-unfinished rule:
 * an unclickable nav item is a broken promise).
 *
 * Keep this list aligned with
 * docs/rebuild-audit/13-ui-information-architecture.md
 * §"BuhlOS Admin information architecture > Left sidebar sections" —
 * that doc is the source of truth for the IA.
 *
 * NOT in this list (by design, so the palette adds them explicitly):
 *   - the /hours/approvals + /hours/weekly sub-tabs (#415 collapsed Hours to
 *     one sidebar item; Day / Approvals / Weekly are in-page HoursTabs);
 *   - /settings/notifications (a sidebar FOOTER link, not a nav-group item, #218).
 */
/**
 * The live-count loops a sidebar item can carry a badge for. Each maps to a
 * cheap, already-shipped summary endpoint (see ./useNavCounts). Deliberately a
 * SUBSET of the office IA: an item only gets a `countKey` when there is a real,
 * cheap source for its number. Loops without one (Command centre criticals, QA
 * exposure, quote pipeline, dayworks) render NO badge rather than a fake zero —
 * the hide-unfinished / honesty rule (CLAUDE.md, brief §0).
 */
export type NavCountKey =
  | "obs"
  | "mats"
  | "exp"
  | "jobs"
  | "defects"
  | "hours"
  | "people"
  | "gear";

export interface NavItem {
  label: string;
  href: Route;
  icon: typeof LayoutGrid;
  /** Path prefix(es) that mark this item active; longest prefix wins
   *  (so a deeper sibling entry would beat /hours on its own pages). */
  activeFor: ReadonlyArray<string>;
  /** Which live count feeds this item's sidebar badge (see useNavCounts).
   *  Omitted = no badge. */
  countKey?: NavCountKey;
  /** When true, a non-zero count renders as a red attention pip (work waiting
   *  on the office: defects, hours, observations, expiring gear) rather than a
   *  muted tally (jobs / people / material requests / expenses). */
  attention?: boolean;
}

export interface NavGroup {
  heading: string;
  items: ReadonlyArray<NavItem>;
}

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
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
        // "From site" — the field-to-office inbox (the route + API keep the
        // /observations name; only the user-facing label reads "From site").
        label: "From site",
        href: "/observations" as Route,
        icon: Inbox,
        activeFor: ["/observations"],
        countKey: "obs",
        attention: true,
      },
      {
        label: "Material requests",
        href: "/material-requests" as Route,
        icon: Package,
        activeFor: ["/material-requests"],
        countKey: "mats",
      },
      {
        // Reimbursements (#536) — field-submitted receipts the office reviews,
        // approves and marks reimbursed. A field→office queue, so it sits with
        // the other "Today" inboxes.
        label: "Expenses",
        href: "/expenses" as Route,
        icon: Wallet,
        activeFor: ["/expenses"],
        countKey: "exp",
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
        countKey: "jobs",
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
        countKey: "defects",
        attention: true,
      },
      {
        label: "ITP templates",
        href: "/itp-templates" as Route,
        icon: ClipboardList,
        activeFor: ["/itp-templates"],
      },
      {
        // Cross-job QA status dashboard (#290) — ITP exposure across active
        // jobs, drilling into each job's /v2/jobs/[jobId]/itps surface.
        label: "QA status",
        href: "/qa" as Route,
        icon: ClipboardCheck,
        activeFor: ["/qa"],
      },
      {
        // Cross-job daywork register (#370) — day-labour dockets + payment risk
        // (unsigned-aging), drilling into each job's /v2/jobs/[jobId]/dayworks.
        label: "Dayworks",
        href: "/v2/dayworks" as Route,
        icon: Receipt,
        activeFor: ["/v2/dayworks"],
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
        countKey: "hours",
        attention: true,
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
        countKey: "people",
      },
      {
        label: "Gear",
        href: "/gear",
        icon: Wrench,
        activeFor: ["/gear"],
        countKey: "gear",
        attention: true,
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

export const ALL_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);

/**
 * The active item is the one whose `activeFor` prefix is the LONGEST match
 * for the pathname. With the hours section collapsed to one entry (#415)
 * the /hours prefix alone keeps it active on /hours, /hours/approvals and
 * /hours/weekly; the longest-prefix rule stays so a future deeper entry
 * (e.g. a dedicated sub-route item) would win over its section root again.
 */
export function activeHref(pathname: string): string | null {
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
