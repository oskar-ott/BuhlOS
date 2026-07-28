import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ExceptionActionState } from "./routes";

export type { ExceptionActionState } from "./routes";

/**
 * Exceptions Inbox ("Needs Attention") — a PROJECTION layer, not a new source
 * of truth. An `ExceptionItem` is derived deterministically from existing,
 * already-permission-gated source records (hours, job stats). The inbox NEVER
 * stores anything and NEVER exposes raw source records — it builds minimal,
 * safe, actionable items that link back to the canonical source surface.
 *
 * The gut pass (docs/product/02-lean-reset.md) removed the observation,
 * material-request, RFI, snag and ITP sources with their features; the
 * projection shape is unchanged for the sources that remain.
 */

export type ExceptionSource =
  | "hours"
  | "evidence"
  | "job"
  | "planMarkup"
  | "gear";

export type ExceptionSeverity = "info" | "warning" | "critical";

/** Coarse lifecycle, only set where the source reliably supports it. */
export type ExceptionStatus = "open" | "waiting" | "blocked" | "resolved";

export interface ExceptionItem {
  /** Stable + unique, e.g. `hours-rejected:te_123`. */
  id: string;
  source: ExceptionSource;
  sourceId: string;
  jobId?: string;
  jobName?: string;
  /** What happened — phrased as an action, not a metric. */
  title: string;
  /** Why it matters / extra context. */
  summary?: string;
  severity: ExceptionSeverity;
  status?: ExceptionStatus;
  ownerRole?: "office" | "field" | "admin";
  createdAt?: string;
  dueAt?: string;
  /** The next action — label + a CANONICAL internal route (starts with "/"). */
  actionLabel?: string;
  actionHref?: string;
  /**
   * Whether the action is usable. `available` → render the link;
   * `unavailable` → the source route isn't reachable for this item (render a
   * muted state, never a broken link); `future` → a planned source not built
   * yet. Derived from the route registry (resolveAction), never persisted.
   */
  actionState: ExceptionActionState;
  /** Why the action is unavailable/future (shown as muted help text). */
  actionReason?: string;
  /** Human label for `source` (set by buildExceptions; used in group headers). */
  sourceLabel?: string;
  /** Relative age of `createdAt`, e.g. "3d ago" — set by decorateAges(now). */
  ageLabel?: string;
  tags?: string[];
}

/** A job (or "General") group of exception items, with rolled-up counts. */
export interface ExceptionJobGroup {
  jobId: string | null;
  jobName: string;
  items: ExceptionItem[];
  count: number;
  highestSeverity: ExceptionSeverity;
}

/** A source group of exception items. */
export interface ExceptionSourceGroup {
  source: ExceptionSource;
  sourceLabel: string;
  items: ExceptionItem[];
  count: number;
}

/** Rolled-up counts for the inbox summary header. */
export interface ExceptionCounts {
  total: number;
  bySeverity: Record<ExceptionSeverity, number>;
  bySource: Partial<Record<ExceptionSource, number>>;
  jobsAffected: number;
  /** Items whose action is clickable now (available or fallback). */
  actionable: number;
  /** Items with no clickable action (unavailable/future). */
  waiting: number;
}

/** Action-availability filter buckets. */
export type ActionAvailability = "all" | "actionable" | "waiting";

/** The already-loaded, admin-gated source snapshot the projection reads. */
export interface ExceptionSources {
  hoursPending: ReadonlyArray<TimeEntry>;
  hoursRejected: ReadonlyArray<TimeEntry>;
  jobs: ReadonlyArray<Job>;
}

export interface ExceptionFilters {
  source?: ExceptionSource | "all";
  severity?: ExceptionSeverity | "all";
  jobId?: string | "all";
  /** "actionable" = available/fallback; "waiting" = unavailable/future. */
  availability?: ActionAvailability;
  /** Free-text match against title / summary / jobName (case-insensitive). */
  query?: string;
}

export interface ExceptionSummary {
  total: number;
  bySeverity: Record<ExceptionSeverity, number>;
  bySource: Partial<Record<ExceptionSource, number>>;
}
