import { LayoutGrid, Briefcase, Clock, Wrench, Users } from "lucide-react";
import type { Route } from "next";
import type { FlagKey } from "../../../api/_lib/feature-flags";

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
 * §"BuhlOS Admin information architecture > Primary nav sections (top nav)" —
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
 * cheap source for its number. Loops without one (Command centre criticals)
 * render NO badge rather than a fake zero — the hide-unfinished / honesty rule
 * (CLAUDE.md, brief §0).
 */
export type NavCountKey = "jobs" | "hours" | "people" | "gear";

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
   *  on the office: hours, expiring gear) rather than a muted tally
   *  (jobs / people). */
  attention?: boolean;
  /**
   * #760 owner feature-control: the kill-switch flag that gates this item. When
   * the flag is off for the viewer, AdminShell hides the item from the sidebar,
   * ⌘K palette and mobile tab bar (and the route itself 404s). Omit for chrome
   * that must always be reachable (Command centre) so the owner can't self-lock.
   */
  flag?: FlagKey;
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
        flag: "jobs",
        countKey: "jobs",
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
        flag: "hours",
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
        flag: "employees",
        countKey: "people",
      },
      {
        // /gear is a coming-soon placeholder for launch: no countKey while the
        // register is parked — an attention pip must not point at a page that
        // can't show the work behind the number.
        label: "Gear",
        href: "/gear",
        icon: Wrench,
        activeFor: ["/gear"],
        flag: "gear",
      },
    ],
  },
];

export const ALL_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap((g) => g.items);

/**
 * #760 owner feature-control: drop nav items whose href is in `hiddenHrefs`
 * (the features the owner has turned off for this viewer), then drop any group
 * left with no items. `hiddenHrefs` is resolved server-side in AdminShell from
 * `flagsForViewer`; an undefined/empty set means "show everything" (the default,
 * and the safe fallback if flag resolution ever fails). Pure + synchronous so
 * the client sidebar / palette / mobile tab bar all filter from one rule.
 */
export function visibleNavGroups(
  hiddenHrefs?: ReadonlyArray<string> | null,
): ReadonlyArray<NavGroup> {
  if (!hiddenHrefs || hiddenHrefs.length === 0) return NAV_GROUPS;
  const hidden = new Set(hiddenHrefs);
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => !hidden.has(it.href)),
  })).filter((g) => g.items.length > 0);
}

/** The subset of ALL_ITEMS that carry a gating flag → their [href, flag] pairs.
 *  AdminShell uses this to resolve which hrefs to hide for the viewer. */
export const FLAGGED_ITEMS: ReadonlyArray<{ href: string; flag: NonNullable<NavItem["flag"]> }> =
  ALL_ITEMS.filter((it) => it.flag).map((it) => ({ href: it.href, flag: it.flag! }));

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
