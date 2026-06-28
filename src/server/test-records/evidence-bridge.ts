import { SESSION_COOKIE } from "@/lib/auth/session";
import { summariseTestRecord } from "@/domains/test-records/derive";
import type { TestRecord } from "@/domains/test-records/schema";

/**
 * The proof-loop bridge for #517 — EXTEND, NEVER FORK.
 *
 * A TestRecord satisfies a `test_result` required-evidence item by minting a REAL
 * companion `EvidenceItem` (kind `test_result`) via the existing `api/evidence.js`
 * POST. That keeps the proof loop's single source of truth untouched: the normal
 * evidence-link writer + `isRequiredEvidenceMet` flip the requirement to met with
 * NO change to `validateEvidenceLink` / `isRequiredEvidenceMet` /
 * `isRequiredEvidenceMetForTask` / `loadJobProofIds`. We do NOT add a
 * `testRecordId` arm to `EvidenceLink`.
 *
 * Minting through `api/evidence.js` (rather than writing `data.json#evidence[]`
 * directly) means the companion item inherits the audit dual-write + idempotency
 * for free, and lands in the SAME `evidence[]` array that `loadJobProofIds` reads —
 * so #513's trusted-proof guard sees it as a real, existing proof id.
 *
 * The companion evidence is JOB-LEVEL (no area/stage/task on the evidence row):
 * the requirement-link scoping is carried by the Phil `linkAndApply` taskRef,
 * exactly as a photo/note proof is scoped. It carries `testRecordId` so the admin
 * review (and a future export) can resolve the structured numbers behind the
 * proof tick, and an honest one-line `note` summary (no invented numbers, P7).
 */

export interface MintTestResultEvidenceInput {
  /** Internal base URL (forwarded host) for the server→server POST. */
  base: string;
  /** The caller's session cookie value, forwarded so api/evidence.js authorises
   *  the same worker that created the record. */
  cookieValue: string | undefined;
  record: TestRecord;
}

export type MintTestResultEvidenceResult =
  | { evidenceId: string; warning?: undefined }
  | { evidenceId: null; warning: string };

/**
 * POST the companion `test_result` evidence. Returns the real `ev_…` id on
 * success, or `{ evidenceId: null, warning }` on any failure (the record itself
 * is already saved — the worker can retry the link without re-entering numbers).
 */
export async function mintTestResultEvidence(
  input: MintTestResultEvidenceInput,
  fetchImpl: typeof fetch = fetch,
): Promise<MintTestResultEvidenceResult> {
  const { record } = input;
  const summary = summariseTestRecord(record);
  let res: Response;
  try {
    res = await fetchImpl(
      `${input.base}/api/evidence?jobId=${encodeURIComponent(record.jobId)}`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(input.cookieValue ? { cookie: `${SESSION_COOKIE}=${input.cookieValue}` } : {}),
          // Idempotency: a retry for the SAME record returns the same evidence
          // item — no duplicate proof rows. Keyed on the record id.
          "Idempotency-Key": `test-record:${record.id}`,
        },
        body: JSON.stringify({
          kind: "test_result",
          // The structured numbers live in `jobs/<jobId>/test-records.json`; the
          // evidence row points back at them. Honest summary, no fake numbers.
          testRecordId: record.id,
          note: summary,
        }),
      },
    );
  } catch {
    return { evidenceId: null, warning: "Could not record the test-result proof — try linking again." };
  }

  if (!res.ok) {
    return { evidenceId: null, warning: "Could not record the test-result proof — try linking again." };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { evidenceId: null, warning: "Could not read the test-result proof response." };
  }
  const id = (body as { evidenceItem?: { id?: unknown } })?.evidenceItem?.id;
  if (typeof id !== "string" || id.length === 0) {
    return { evidenceId: null, warning: "The test-result proof did not return an id." };
  }
  return { evidenceId: id };
}
