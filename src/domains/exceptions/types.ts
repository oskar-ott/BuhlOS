import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { MaterialRequestItem } from "@/domains/material-requests/types";

/**
 * Exceptions Inbox ("Needs Attention") — a PROJECTION layer, not a new source
 * of truth. An `ExceptionItem` is derived deterministically from existing,
 * already-permission-gated source records (hours, observations, job stats,
 * material requests). The inbox NEVER stores anything and NEVER exposes raw
 * source records — it builds minimal, safe, actionable items that link back to
 * the canonical source surface.
 *
 * Named `exceptions` (not `observations`) on purpose: `src/domains/observations`
 * is a distinct field-capture record store that is ONE source feeding this
 * projection.
 */

export type ExceptionSource =
  | "hours"
  | "observation"
  | "evidence"
  | "snag"
  | "itp"
  | "job"
  | "material"
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
  tags?: string[];
}

/** The already-loaded, admin-gated source snapshot the projection reads. */
export interface ExceptionSources {
  hoursPending: ReadonlyArray<TimeEntry>;
  hoursRejected: ReadonlyArray<TimeEntry>;
  jobs: ReadonlyArray<Job>;
  observations: ReadonlyArray<ObservationItem>;
  materialRequests: ReadonlyArray<MaterialRequestItem>;
}

export interface ExceptionFilters {
  source?: ExceptionSource | "all";
  severity?: ExceptionSeverity | "all";
  jobId?: string | "all";
}

export interface ExceptionSummary {
  total: number;
  bySeverity: Record<ExceptionSeverity, number>;
  bySource: Partial<Record<ExceptionSource, number>>;
}
