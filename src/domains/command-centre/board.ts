import type { ExceptionItem, ExceptionSeverity } from "@/domains/exceptions/types";

/**
 * Command Centre board view-model (brief §2). A pure projection over signals the
 * page already loads (the needs-attention exceptions projection + the per-loop
 * open-work counts + today's pulse) into the four-zone glance board: a state-of-
 * play hero, four pulse tiles, the criticals as ≤4 action cards, and open work
 * as a colour-graded heatmap.
 *
 * Pure + deterministic so it is unit-tested in isolation; the page does the
 * (permission-gated) loading and renders this VM. No new source of truth.
 */

export type BoardTone = "calm" | "busy" | "critical";
export type HeatLevel = "calm" | "amber" | "red";

/**
 * The lucide icon vocabulary the board references by name (the page maps each
 * to a component). Kept as string keys so this module stays pure/server-safe
 * and free of React imports. Mirrors NeedsNowCards' SOURCE_ICON set so the
 * open-work tiles and the "needs you now" cards share one icon language.
 */
export type BoardIcon =
  | "clipboard-check"
  | "briefcase"
  | "camera"
  | "alert-octagon"
  | "file-check"
  | "inbox"
  | "rotate-ccw"
  | "user-x"
  | "layers"
  | "package";

/** critical first, then warning; info never reaches needsNow. */
const SEVERITY_RANK: Record<ExceptionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const NEEDS_NOW_CAP = 4;
const HEAT_RED = 8;
const HEAT_AMBER = 4;

export interface PulseTile {
  key: string;
  label: string;
  /** Pre-formatted display value, or "—" when the signal didn't load — never a fake 0. */
  value: string;
  /** On-the-clock conic-ring fill 0..100; set only when a real roster denominator exists. */
  ringPct?: number;
  /** Ring denominator text, e.g. "/21" — set only alongside ringPct. */
  denom?: string;
  /** Highlight the tile (e.g. approvals waiting). */
  amber?: boolean;
  /** Optional leading icon (clipboard-check on approvals, briefcase on jobs). */
  icon?: BoardIcon;
}

/** A single open-work loop: its count and the surface that owns it. */
export interface OpenWorkInput {
  key: string;
  label: string;
  count: number;
  href: string;
  /** Corner icon, recoloured by heat in the tile (same vocabulary as NeedsNow). */
  icon?: BoardIcon;
}
export interface OpenWorkTile extends OpenWorkInput {
  heat: HeatLevel;
}

export interface BoardSignals {
  /** Distinct crew with hours logged today (today-pulse crewOnSite). null = not loaded. */
  crewOnSite: number | null;
  /** Optional roster denominator for the ring; null = render a plain number (honest). */
  rosterTotal: number | null;
  /** Pre-formatted logged-hours label ("15h 12m"); null = not loaded. */
  loggedHoursLabel: string | null;
  /** Timesheets awaiting approver action. */
  pendingApprovals: number;
  /** Jobs with activity today; null = not loaded. */
  jobsLiveToday: number | null;
  /** The needs-attention projection (already permission-gated upstream). */
  exceptions: ReadonlyArray<ExceptionItem>;
  /** Open-work buckets across the loops (count per loop + its surface link). */
  openWork: ReadonlyArray<OpenWorkInput>;
}

export interface BoardVM {
  hero: { tone: BoardTone; headline: string; tag: string };
  pulse: PulseTile[];
  needsNow: {
    /** ALL actionable (non-info) items, critical-first. The UI shows `cap` and
     *  expands to the rest behind a "+N more" toggle. */
    items: ReadonlyArray<ExceptionItem>;
    /** Default display cap before "+N more". */
    cap: number;
    /** Count of all actionable items (= items.length). */
    total: number;
  };
  openWork: {
    /** count>0, busiest first, colour-graded. */
    tiles: ReadonlyArray<OpenWorkTile>;
    /** Sum of every loop's count (the zone tally). */
    total: number;
  };
}

/** red ≥8 · amber ≥4 · calm below — the brief's heatmap thresholds. */
export function heatFor(count: number): HeatLevel {
  if (count >= HEAT_RED) return "red";
  if (count >= HEAT_AMBER) return "amber";
  return "calm";
}

export function buildBoard(signals: BoardSignals): BoardVM {
  const { exceptions, openWork } = signals;

  // ── Needs you now: actionable (non-info), critical first, capped ──
  const actionable = exceptions
    .filter((e) => e.severity !== "info")
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const criticalCount = actionable.filter((e) => e.severity === "critical").length;

  // ── Open work: count>0, busiest first, colour-graded ──
  const tiles = openWork
    .filter((q) => q.count > 0)
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((q) => ({ ...q, heat: heatFor(q.count) }));
  const openTotal = openWork.reduce((sum, q) => sum + Math.max(0, q.count), 0);

  // ── Hero: critical decisions win; else busy if anything's open; else calm ──
  let tone: BoardTone;
  let tag: string;
  let headline: string;
  if (criticalCount > 0) {
    tone = "critical";
    tag = "CRITICAL";
    headline = `${criticalCount} ${
      criticalCount === 1 ? "decision is" : "decisions are"
    } holding crews up right now.`;
  } else if (actionable.length > 0 || openTotal > 0) {
    tone = "busy";
    tag = "BUSY";
    headline =
      actionable.length > 0
        ? `${actionable.length} ${
            actionable.length === 1 ? "item needs" : "items need"
          } action — nothing critical.`
        : `${openTotal} open ${
            openTotal === 1 ? "item" : "items"
          } across the loops — no decisions blocking crews.`;
  } else {
    tone = "calm";
    tag = "CALM";
    headline = "The desk is calm — nothing is holding a crew up.";
  }

  // ── Pulse: four tiles; null signals render "—", never a fabricated 0 ──
  const ringPct =
    signals.crewOnSite != null && signals.rosterTotal && signals.rosterTotal > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((signals.crewOnSite / signals.rosterTotal) * 100)),
        )
      : undefined;
  const pulse: PulseTile[] = [
    {
      key: "onclock",
      label: "on the clock",
      value: signals.crewOnSite == null ? "—" : String(signals.crewOnSite),
      ...(signals.rosterTotal != null ? { denom: `/${signals.rosterTotal}` } : {}),
      ...(ringPct != null ? { ringPct } : {}),
    },
    {
      key: "logged",
      label: "logged today",
      value: signals.loggedHoursLabel ?? "—",
    },
    {
      key: "pending",
      label: "pending approvals",
      value: String(signals.pendingApprovals),
      amber: signals.pendingApprovals > 0,
      icon: "clipboard-check",
    },
    {
      key: "jobs",
      label: "jobs live today",
      value: signals.jobsLiveToday == null ? "—" : String(signals.jobsLiveToday),
      icon: "briefcase",
    },
  ];

  return {
    hero: { tone, headline, tag },
    pulse,
    needsNow: {
      items: actionable,
      cap: NEEDS_NOW_CAP,
      total: actionable.length,
    },
    openWork: { tiles, total: openTotal },
  };
}
