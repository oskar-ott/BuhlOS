import type { TestRecordInput } from "@/domains/test-records/schema";

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
  | { kind: "ok"; evidenceId: string }
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
    res = await fetchImpl("/api/job-control/test-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
  } catch {
    return { kind: "error", message: "Network error" };
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
  };

  if (res.ok && b.ok) {
    if (typeof b.evidenceId === "string" && b.evidenceId.length > 0) {
      return { kind: "ok", evidenceId: b.evidenceId };
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
