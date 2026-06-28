import { randomUUID } from "node:crypto";
import {
  TEST_RECORD_ID_PREFIX,
  TestRecordStoreSchema,
  type TestRecord,
  type TestRecordInput,
  type TestRecordStore,
} from "@/domains/test-records/schema";
import { buildTestRecord } from "@/domains/test-records/derive";
import { readJsonBlob, writeJsonBlob } from "@/server/job-control/blob";

/**
 * Persistence for structured electrical test records (#517).
 *
 * A TestRecord is captured by a field worker (continuity / IR / RCD / Zs / polarity
 * …) and stored per job at `jobs/<jobId>/test-records.json`. The pure domain
 * (schema + the one pass/fail rule + `buildTestRecord`) already shipped in
 * `src/domains/test-records/`; this is the thin server layer that appends a
 * validated record to the store.
 *
 * It lives in TS (NOT a legacy `api/*.js` function) because, per the job-control
 * runtime ADR (#463), JS Vercel functions cannot import the typed domain — and
 * the derivation MUST run through `buildTestRecord` so pass/fail is server-derived,
 * never client-asserted (P7). Design mirrors the L0–L4 producers: a pure core
 * (`applyTestRecord`) + injectable I/O deps (`TestRecordDeps`), unit-tested
 * without Next; `blobTestRecordDeps()` wires the real blob helpers.
 *
 * Hard rules:
 *   - IMMUTABLE + SUPERSEDE-BY-REVISION (AC3). A record is NEVER edited in place.
 *     A correction is a NEW record carrying `supersedesId` pointing at the record
 *     it replaces — the superseded record stays in the store, byte-identical, so
 *     the audit trail is complete and the admin review can show the history.
 *   - SERVER-AUTHORITATIVE DERIVATION. Every row's pass/fail and the overall
 *     status are re-derived here via `buildTestRecord`; any client-smuggled
 *     `status` is ignored.
 *   - Append-only write: a create reads the store, appends, and writes back the
 *     full document (same full-doc-rewrite pattern as the evidence/snag stores).
 */

/** The store key for a job's test records. */
export function testRecordsKey(jobId: string): string {
  return `jobs/${jobId}/test-records.json`;
}

// ── Pure apply ───────────────────────────────────────────────────────────────

export type TestRecordApplyResult =
  | { ok: true; store: TestRecordStore; record: TestRecord }
  | { ok: false; reason: "unknown_supersede" };

/**
 * Append a freshly-built TestRecord to the store. PURE — no I/O, no mutation of
 * the input. When `input.supersedesId` is set, the referenced record must already
 * exist (a correction supersedes a real record, never a phantom); the prior
 * record is LEFT IN PLACE (immutability — never edited or removed).
 */
export function applyTestRecord(
  store: TestRecordStore,
  input: TestRecordInput,
  ctx: { id: string; at: string; createdBy?: string | null },
): TestRecordApplyResult {
  // A correction must point at a record that exists — otherwise reject, so a
  // `supersedesId` can never dangle.
  if (input.supersedesId != null) {
    const target = store.records.find((r) => r.id === input.supersedesId);
    if (!target) return { ok: false, reason: "unknown_supersede" };
  }

  const record = buildTestRecord(input, ctx);
  // Append — never replace. The superseded record stays exactly as it was.
  const next: TestRecordStore = { ...store, records: [...store.records, record] };
  return { ok: true, store: next, record };
}

// ── Orchestration (I/O via injected deps) ─────────────────────────────────────

export interface TestRecordDeps {
  /** Load the raw store for a job, or null when it does not exist. */
  loadRaw(jobId: string): Promise<unknown | null>;
  /** Persist the updated store. Called ONLY when a record is appended. */
  save(jobId: string, store: TestRecordStore): Promise<void>;
  /** Mint a fresh `tr_…` record id. */
  mintId(): string;
}

export type WriteTestRecordResult =
  | { ok: true; status: 200; record: TestRecord }
  | {
      ok: false;
      status: 409;
      reason: "unreadable" | "unknown_supersede";
      warning: string;
    };

const WARNINGS: Record<Exclude<WriteTestRecordResult, { ok: true }>["reason"], string> = {
  unreadable:
    "The test-records store for this job is unreadable — the record was not saved (store left untouched).",
  unknown_supersede:
    "The record this correction supersedes does not exist on this job — nothing was saved.",
};

/**
 * Write flow: load → (validate the store is readable) → build + append → persist.
 * A missing store is the normal first-write case (an empty store is used). An
 * unreadable store is failed-soft with a structured warning and NO write — the
 * existing records are never overwritten by a bad parse.
 */
export async function writeTestRecord(
  deps: TestRecordDeps,
  input: {
    jobId: string;
    record: TestRecordInput;
    at: string;
    createdBy?: string | null;
  },
): Promise<WriteTestRecordResult> {
  const raw = await deps.loadRaw(input.jobId);

  // Missing store → first write on this job: start from an empty, valid store.
  // Present but unparseable → fail-closed (never clobber an existing store).
  let store: TestRecordStore;
  if (raw == null) {
    store = { records: [] };
  } else {
    const parsed = TestRecordStoreSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, status: 409, reason: "unreadable", warning: WARNINGS.unreadable };
    }
    store = parsed.data;
  }

  const applied = applyTestRecord(store, input.record, {
    id: deps.mintId(),
    at: input.at,
    createdBy: input.createdBy,
  });
  if (!applied.ok) {
    return { ok: false, status: 409, reason: applied.reason, warning: WARNINGS[applied.reason] };
  }

  await deps.save(input.jobId, applied.store);
  return { ok: true, status: 200, record: applied.record };
}

/**
 * Read a job's test records for admin review (AC2). Never throws on a missing or
 * unreadable store — it yields an empty list so the panel shows "none yet", not
 * an error the office can't act on.
 */
export async function readTestRecords(
  deps: Pick<TestRecordDeps, "loadRaw">,
  jobId: string,
): Promise<{ records: TestRecord[] }> {
  const raw = await deps.loadRaw(jobId);
  if (raw == null) return { records: [] };
  const parsed = TestRecordStoreSchema.safeParse(raw);
  if (!parsed.success) return { records: [] };
  return { records: parsed.data.records };
}

// ── Real deps (Vercel Blob) ───────────────────────────────────────────────────

export function blobTestRecordDeps(): TestRecordDeps {
  return {
    loadRaw: (jobId) => readJsonBlob<unknown>(testRecordsKey(jobId), null),
    save: (jobId, store) => writeJsonBlob(testRecordsKey(jobId), store),
    mintId: () => `${TEST_RECORD_ID_PREFIX}${randomUUID()}`,
  };
}
