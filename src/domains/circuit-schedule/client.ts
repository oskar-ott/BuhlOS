import { httpGet, httpPut, type HttpResult } from "@/lib/http";
import { CircuitBoardsResponseSchema, type Board, type CircuitBoardsResponse } from "./schema";

/**
 * Typed wrappers around the `boards` facet of /api/job-circuits (the only
 * writer for the rich circuit schedule).
 *
 *   GET /api/job-circuits?jobId=<id>  → { switchboards, circuits, boards }
 *   PUT /api/job-circuits?jobId=<id>  body { boards } → replaces boards
 *                                     wholesale, returns the normalised set.
 *
 * Read access is anyone who can see the job; the PUT is server-gated to
 * canManageJob, so a non-manager save round-trips a 403 the builder surfaces
 * as a read-only notice. The schema parse is the lenient one the page loader
 * uses, so an unknown server value never blanks the schedule.
 */

export function fetchCircuitBoards(
  jobId: string,
): Promise<HttpResult<CircuitBoardsResponse>> {
  return httpGet<CircuitBoardsResponse>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}`,
    {
      schema: CircuitBoardsResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    },
  );
}

export function saveCircuitBoards(
  jobId: string,
  boards: Board[],
): Promise<HttpResult<CircuitBoardsResponse>> {
  return httpPut<CircuitBoardsResponse>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}`,
    { boards },
    {
      schema: CircuitBoardsResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
      // Field write on possibly-bad signal — fail honestly rather than hang.
      timeoutMs: 20000,
    },
  );
}
