import type { ExpiringCalibration } from "@/domains/gear/types";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Pure selector for the Phil My Day "Needs you" feed — the logged-in field
 * worker's real, actionable attention items, aggregated across their assigned
 * jobs.
 *
 * HONEST BY CONSTRUCTION. Every item is backed by a real data source and a
 * real route; nothing is fabricated. Only two item kinds are wired today
 * because only two have a real, worker-attributable source:
 *
 *   - rejected-hours: a time entry the office rejected (status "rejected").
 *       Source: GET /api/time-entries (self-scoped to the worker).
 *       Action: /phil/my-day?fixDate=<date> — selects that day and auto-opens
 *       the inline fix-and-resubmit sheet (same deep link the "Hours rejected"
 *       push notification uses).
 *   - calibration: a test instrument THIS WORKER currently holds whose
 *       calibration is expired or due within 14 days (#305). Source:
 *       GET /api/tags-expiring `calibrations` (already holder-filtered
 *       server-side for non-admin viewers). Action: their Phil gear list.
 *
 * Deliberately NOT included (no real, worker-attributable source — see
 * docs/phil-my-day-needs-you.md): assigned tasks (job-level, no assignee/due),
 * required evidence (no required-vs-supplied model), ITP/sign-off (job/role
 * scoped), RFIs (do not exist), and weekly "Submit timesheet" (no weekly
 * batch-submit workflow). When nothing is real, the feed is empty — never a
 * placeholder row.
 */
export type PhilNeedsYouKind = "rejected-hours" | "calibration";
export type PhilNeedsYouSeverity = "urgent" | "warning" | "normal";

export interface PhilNeedsYouItem {
  id: string;
  kind: PhilNeedsYouKind;
  title: string;
  detail?: string;
  meta?: string;
  /** A real in-app route — never empty, never a dead link. */
  href: string;
  actionLabel: string;
  severity: PhilNeedsYouSeverity;
}

export interface PhilNeedsYouInput {
  /** The logged-in worker. Calibrations are only attributed when this is set. */
  viewerId: string | null;
  /** The worker's recent time entries (the page already loads these). */
  entries: ReadonlyArray<TimeEntry>;
  /**
   * Expiring/expired calibrations on gear the worker HOLDS, from
   * /api/tags-expiring (#305). Optional so existing callers/tests are
   * untouched; absent ≙ none.
   */
  calibrations?: ReadonlyArray<ExpiringCalibration>;
}

const SEVERITY_RANK: Record<PhilNeedsYouSeverity, number> = {
  urgent: 0,
  warning: 1,
  normal: 2,
};

function shortDay(dateISO: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return dateISO;
  return new Date(dateISO + "T00:00:00").toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function hoursLabel(totalHours: number): string {
  if (!(totalHours > 0)) return "";
  const mins = Math.round(totalHours * 60);
  const h = Math.floor(mins / 60);
  const m = mins - h * 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function buildPhilNeedsYou(input: PhilNeedsYouInput): PhilNeedsYouItem[] {
  const items: PhilNeedsYouItem[] = [];

  // A. Rejected hours — real and blocks pay; the most urgent thing a worker
  //    can clear. A rejection always carries a date; the reason is shown when
  //    the office left one. The link is the same ?fixDate= deep link the push
  //    notification uses: one tap opens that day with the fix sheet expanded.
  for (const e of input.entries) {
    if (e.status !== "rejected") continue;
    items.push({
      id: `rejected-hours:${e.id}`,
      kind: "rejected-hours",
      title: `${shortDay(e.date)} hours need a fix`,
      detail: e.rejectedReason ?? undefined,
      meta: hoursLabel(e.totalHours) || undefined,
      href: `/phil/my-day?fixDate=${encodeURIComponent(e.date)}`,
      actionLabel: "Fix hours",
      severity: "urgent",
    });
  }

  // C. Calibration lapses on gear in MY hands (#305) — an expired
  //    calibration means "stop testing with this instrument", which the
  //    worker needs to hear before they use it today. Server already scopes
  //    rows to the holder for non-admin viewers; the holderId check repeats
  //    that defensively so an admin viewing Phil never sees the whole fleet.
  for (const c of input.calibrations ?? []) {
    if (input.viewerId && c.holderId && c.holderId !== input.viewerId) continue;
    const due = c.calibrationDue.slice(0, 10);
    items.push({
      id: `calibration:${c.assetId}`,
      kind: "calibration",
      title:
        c.status === "expired"
          ? `${c.assetName} calibration expired`
          : `${c.assetName} calibration due ${shortDay(due)}`,
      detail:
        c.status === "expired"
          ? `Don't test with it — was due ${shortDay(due)}.`
          : undefined,
      meta: c.identifier ?? undefined,
      href: "/phil/gear",
      actionLabel: "View gear",
      severity: c.status === "expired" ? "urgent" : "warning",
    });
  }

  // urgent → warning → normal; stable within a rank (Array.sort is stable).
  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
