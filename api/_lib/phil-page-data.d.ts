// Type declarations for the CommonJS in-process Phil page loaders
// (api/_lib/phil-page-data.js) so the /phil/* server pages consume them
// type-checked. Entries/jobs stay `unknown` on purpose: the pages run them
// through the same lenient validators they applied to the HTTP responses
// (parseTimeEntryListLenient / JobListResponseSchema), which own the shapes.

export interface InProcessEntriesResult {
  ok: boolean;
  /** Mirrors the HTTP handler status the pages used to surface (401 when unauthenticated). */
  status: number;
  entries: unknown[];
}

export interface InProcessJobsResult {
  ok: boolean;
  jobs: unknown[];
}

/** Fresh users.json user (password hash stripped) or null — shape-gate with parseSessionUser. */
export declare function loadCurrentUserInProcess(
  cookieValue: string | undefined
): Promise<unknown>;

export declare function loadWorkerEntriesInProcess(
  cookieValue: string | undefined,
  opts?: { fromDate?: string; toDate?: string }
): Promise<InProcessEntriesResult>;

export declare function loadFieldJobsInProcess(
  cookieValue: string | undefined
): Promise<InProcessJobsResult>;

/** True iff the signed-in worker's employee record is role: apprentice —
 *  drives the TAFE-day option (2026-08-10). Fail-closed: any miss is false. */
export declare function loadIsApprenticeInProcess(
  cookieValue: string | undefined
): Promise<boolean>;
