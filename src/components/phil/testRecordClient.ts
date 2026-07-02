import {
  TestRecordSchema,
  type TestRecord,
  type TestRecordInput,
} from "@/domains/test-records/schema";
import {
  boundedFetch,
  PhilWriteTimeoutError,
  PHIL_NETWORK_MESSAGE,
} from "@/domains/phil/write-client";

/**
 * Phil client for the structured TestRecord route (#517). Narrow: one POST that
 * saves the record (server re-derives pass/fail) and returns the id of the
 * companion `test_result` EvidenceItem the route minted. The caller then runs the
 * EXISTING `linkAndApply({ evidenceId, … })` — the SAME proof-link pathway a
 * photo/note proof uses — so the requirement flips to met only after that link
 * route confirms (non-optimistic, unchanged).
 *
 * It NEVER reports `met` and NEVER invents an evidence id — the server mints the
 * real one and returns it.
 */

export type SubmitTestRecordResult =
  /** `record` is the SERVER-derived stored record (id + per-row pass/fail) —
   *  null when the response body didn't carry a parseable record. #520 uses
   *  it to show the worker their failed circuits and offer "Report defect". */
  | { kind: "ok"; evidenceId: string; record: TestRecord | null }
  /** Saved, but the companion proof could not be minted — the worker can retry
   *  the link without re-entering the numbers. */
  | { kind: "saved_unlinked"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

export async function submitTestRecord(
  input: TestRecordInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitTestRecordResult> {
  let res: Response;
  try {
    // Bounded (#139): entered on site — never hang on bad signal. NOT
    // replay-safe: this POST creates a record (no idempotency key on the
    // route yet), so a retry after an ambiguous timeout could store the
    // readings twice. Manual retry only — the timeout copy says "may not
    // have sent" so the worker isn't told it definitely failed (P7).
    res = await boundedFetch(fetchImpl)("/api/job-control/test-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
  } catch (err) {
    if (err instanceof PhilWriteTimeoutError) {
      return { kind: "error", message: err.message };
    }
    return { kind: "error", message: PHIL_NETWORK_MESSAGE };
  }

  if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to status-based mapping */
  }
  const b = (body ?? {}) as {
    ok?: boolean;
    error?: string;
    evidenceId?: string | null;
    evidenceWarning?: string;
    record?: unknown;
  };

  if (res.ok && b.ok) {
    if (typeof b.evidenceId === "string" && b.evidenceId.length > 0) {
      // The route returns the stored record alongside the evidence id; parse
      // defensively — a missing/unparseable record degrades to null (the
      // submit still succeeded).
      const parsedRecord = TestRecordSchema.safeParse(b.record);
      return {
        kind: "ok",
        evidenceId: b.evidenceId,
        record: parsedRecord.success ? parsedRecord.data : null,
      };
    }
    // The record saved but the companion proof didn't mint — tell the worker it's
    // saved and to retry the link, never that proof is done.
    return {
      kind: "saved_unlinked",
      message: b.evidenceWarning ?? "Saved, but couldn't attach as proof. Try again.",
    };
  }
  if (res.status === 400) {
    return { kind: "invalid", message: b.error ?? "Some readings are missing. Check and try again." };
  }
  return { kind: "error", message: "Couldn't save the test. Try again." };
}
