import type { Route } from "next";
import {
  LayoutGrid,
  Calculator,
  BarChart3,
  Briefcase,
  Users,
  Bell,
  CheckSquare,
  CalendarRange,
  FilePlus2,
} from "lucide-react";
import { ALL_ITEMS } from "./nav";
import type { RecentItem } from "@/lib/storage/recent-items";

/**
 * ⌘K command-palette model (#215) — the pure, testable core of the palette.
 *
 * The component (CommandPalette.tsx) is thin chrome over these functions: it
 * renders the groups they build and walks the flat index they define. Keeping
 * the logic here mirrors the repo convention (nav.ts / recent-items.ts) and
 * lets the node test-runner pin behaviour without a DOM.
 *
 * The palette is a NAVIGATION layer, not a mutation surface. Every command and
 * action resolves to a route the viewer can already reach from the sidebar or
 * a button — ⌘K just makes it one keystroke. No command performs a write, and
 * none points at a destination the admin tier can't open (the surface is
 * admin-gated by middleware; search visibility is scoped server-side).
 */

/** One actionable row. `href` is where Enter / click navigates. */
export interface PaletteCommand {
  /** Stable id (group-scoped) — React key + test handle. */
  id: string;
  /** Row label (truncated in the UI if long). */
  label: string;
  /** Optional sub-label (e.g. the section a sub-tab belongs to). */
  hint?: string;
  /** Destination route. */
  href: Route;
  /** Icon, mirroring the sidebar's lucide vocabulary. */
  icon: typeof LayoutGrid;
}

/** Sub-tabs / footer destinations that aren't standalone NAV items (#415/#218)
 *  but are real routes the operator jumps to. Listed explicitly so they appear
 *  in "Go to" without polluting the sidebar's grouped IA. */
const EXTRA_GO_TO: ReadonlyArray<PaletteCommand> = [
  {
    id: "hours-approvals",
    label: "Hours — Approvals",
    hint: "Hours",
    href: "/hours/approvals" as Route,
    icon: CheckSquare,
  },
  {
    id: "hours-weekly",
    label: "Hours — Weekly closeout",
    hint: "Hours",
    href: "/hours/weekly" as Route,
    icon: CalendarRange,
  },
  {
    id: "settings-notifications",
    label: "Notification settings",
    hint: "Settings",
    href: "/settings/notifications" as Route,
    icon: Bell,
  },
];

/**
 * #760: a command is hidden when its href is, or sits under, an owner-disabled
 * feature href (so "New job" → /v2/jobs/new hides when /v2/jobs is off, and
 * "Open approvals" → /hours/approvals hides when /hours is off).
 */
function makeHiddenPredicate(
  hiddenHrefs?: ReadonlyArray<string> | null,
): (href: string) => boolean {
  if (!hiddenHrefs || hiddenHrefs.length === 0) return () => false;
  const hidden = Array.from(new Set(hiddenHrefs));
  return (href: string) => hidden.some((h) => href === h || href.startsWith(`${h}/`));
}

/**
 * "Go to" = every live NAV destination (the same objects the sidebar renders,
 * via ALL_ITEMS) plus the explicit sub-tab / settings routes above. Sidebar
 * order is preserved; the extras trail it. #760: owner-disabled features are
 * dropped so the palette can't navigate to a hidden surface.
 */
export function buildGoToCommands(hiddenHrefs?: ReadonlyArray<string> | null): PaletteCommand[] {
  const isHidden = makeHiddenPredicate(hiddenHrefs);
  const fromNav: PaletteCommand[] = ALL_ITEMS.filter((item) => !isHidden(item.href)).map((item) => ({
    id: `nav:${item.href}`,
    label: item.label,
    href: item.href,
    icon: item.icon,
  }));
  return [...fromNav, ...EXTRA_GO_TO.filter((c) => !isHidden(c.href))];
}

/**
 * "Actions" = navigational shortcuts to start something — each one just opens
 * a page where the work is created (a new job form, the quotes surface, the
 * approvals queue, reports, notification prefs). NONE mutate from the palette:
 * "New job" opens the builder, it does not POST a job. Mutating actions and a
 * "New defect" command are deliberately out of scope (#215 body / addendum).
 */
export function buildActionCommands(hiddenHrefs?: ReadonlyArray<string> | null): PaletteCommand[] {
  const isHidden = makeHiddenPredicate(hiddenHrefs);
  return [
    { id: "new-job", label: "New job", href: "/v2/jobs/new" as Route, icon: FilePlus2 },
    { id: "new-quote", label: "New quote", href: "/v2/quotes" as Route, icon: Calculator },
    { id: "open-approvals", label: "Open approvals", href: "/hours/approvals" as Route, icon: CheckSquare },
    { id: "open-reports", label: "Open reports", href: "/reports" as Route, icon: BarChart3 },
    {
      id: "notification-prefs",
      label: "Notification preferences",
      href: "/settings/notifications" as Route,
      icon: Bell,
    },
  ].filter((c) => !isHidden(c.href));
}

/** A recent row promoted to a command (so keyboard nav is uniform). */
export function recentToCommand(recent: RecentItem): PaletteCommand {
  return {
    id: `recent:${recent.path}`,
    label: recent.title,
    hint: recent.type === "job" ? "Job" : "Person",
    href: recent.path as Route,
    icon: recent.type === "job" ? Briefcase : Users,
  };
}

/** Minimum query length before the palette queries the search endpoint. */
export const PALETTE_MIN_CHARS = 2;

/**
 * The static (non-search) sections, in render + keyboard order: Go to, then
 * Actions, then Recent. Recent is OMITTED entirely when empty — first run
 * shows Go to + Actions only, never a "no recents" scold (#215 AC).
 *
 * When the user is searching (≥2 chars) these are hidden and the live Results
 * group takes over; that group is built in the component from the shared
 * search domain (groupResults / flattenGroups), not here.
 */
export interface PaletteSection {
  id: "go-to" | "actions" | "recent";
  heading: string;
  commands: PaletteCommand[];
}

export function buildStaticSections(
  recents: ReadonlyArray<RecentItem>,
  hiddenHrefs?: ReadonlyArray<string> | null,
): PaletteSection[] {
  const sections: PaletteSection[] = [
    { id: "go-to", heading: "Go to", commands: buildGoToCommands(hiddenHrefs) },
    { id: "actions", heading: "Actions", commands: buildActionCommands(hiddenHrefs) },
  ];
  if (recents.length > 0) {
    sections.push({
      id: "recent",
      heading: "Recent",
      commands: recents.map(recentToCommand),
    });
  }
  return sections;
}

/** Flat, render-ordered command list — what ↑/↓ walks across all sections. */
export function flattenSections(sections: ReadonlyArray<PaletteSection>): PaletteCommand[] {
  return sections.flatMap((s) => s.commands);
}

/**
 * Move a highlight index by `delta` within `[0, count)` with wraparound.
 * `count === 0` parks at -1 (nothing to highlight). Pure so the wrap logic is
 * unit-pinned independently of the DOM event that triggers it.
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const start = current < 0 ? (delta < 0 ? 0 : -1) : current;
  return (((start + delta) % count) + count) % count;
}

/**
 * Whether a global ⌘K / Ctrl+K keydown should OPEN the palette.
 *
 * Precedence rules (deliberate, single source so the component and its tests
 * agree):
 *   1. Must be the K chord with the platform command/control modifier.
 *   2. SUPPRESS when another modal owns the screen — any open drawer/modal
 *      renders `aria-modal="true"` (Drawer/Modal/SnagDrawer/ITPDrawer/
 *      EvidenceDrawer all do). The drawer keeps its own Esc; we don't layer
 *      a second dialog over it. (When the palette itself is already open this
 *      also matches, which is fine — the component ignores the toggle while
 *      open and its own Esc closes it.)
 *   3. Typing in a text field does NOT suppress ⌘K — the chord is unambiguous
 *      with a modifier held, and the operator expects ⌘K to work mid-typing
 *      (the "open IV3232 while editing" journey). This differs from the bare
 *      "/" focus shortcut, which IS suppressed in inputs.
 *
 * `hasOpenModal` is injected (the component passes a DOM probe) so this stays
 * pure and testable.
 */
export function shouldOpenFromKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  hasOpenModal: boolean
): boolean {
  const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
  if (!isCmdK) return false;
  if (hasOpenModal) return false;
  return true;
}
