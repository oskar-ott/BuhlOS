import type {
  ObservationItem,
  ObservationPriority,
  ObservationStatus,
  ObservationType,
} from "@/domains/observations/types";

/**
 * Pure filter predicate behind the office Observations Inbox (#260).
 *
 * Extracted from ObservationsInbox so the matrix is unit-testable without
 * rendering (mirrors evidence-filter.test.ts → matchesFilter). The inbox owns
 * the option lists and the UI; this module owns only the AND-combine logic.
 *
 * #260 adds the `createdById` (raised-by) and `fromDate`/`toDate` (created-at)
 * axes alongside the existing status/type/priority/job/source filters. Date
 * comparison uses ISO YYYY-MM-DD prefix-matching against `createdAt` (a full
 * ISO string), identical to the evidence filter's capturedAt handling.
 */
export interface ObservationFilters {
  status: ObservationStatus | "";
  type: ObservationType | "";
  priority: ObservationPriority | "";
  jobId: string;
  source: string;
  /** Raised-by filter (#260). "" = anyone; an exact createdById otherwise. */
  createdById: string;
  fromDate: string; // YYYY-MM-DD, "" = no lower bound
  toDate: string;   // YYYY-MM-DD, "" = no upper bound
}

export const EMPTY_OBSERVATION_FILTERS: ObservationFilters = {
  status: "",
  type: "",
  priority: "",
  jobId: "",
  source: "",
  createdById: "",
  fromDate: "",
  toDate: "",
};

export function matchesObservationFilter(
  o: ObservationItem,
  filters: ObservationFilters
): boolean {
  if (filters.status && o.status !== filters.status) return false;
  if (filters.type && o.type !== filters.type) return false;
  if (filters.priority && o.priority !== filters.priority) return false;
  if (filters.jobId && o.jobId !== filters.jobId) return false;
  if (filters.source && o.source !== filters.source) return false;
  if (filters.createdById && o.createdById !== filters.createdById) return false;
  if (filters.fromDate || filters.toDate) {
    const day = typeof o.createdAt === "string" ? o.createdAt.slice(0, 10) : "";
    if (filters.fromDate && day < filters.fromDate) return false;
    if (filters.toDate && day > filters.toDate) return false;
  }
  return true;
}
