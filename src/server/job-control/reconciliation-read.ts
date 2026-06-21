import {
  PersistedScopeReconciliationSchema,
  scopeReconciliationKey,
  type PersistedScopeReconciliation,
} from "./reconciliation-producer";
import type { ScopeClassification, ReconciliationStatus } from "@/domains/job-control/reconciliation";
import { readJsonBlob } from "./blob";

/**
 * Scope-reconciliation READER (#366) — the boss-facing office view of the
 * confirmed scope-vs-quote reconciliation. The mirror of the job-control proof
 * reader (status.ts): read-only, server-only, NO auth of its own, so it MUST be
 * called from an already-admin-gated path (the `/v2/jobs/[jobId]/scope` page,
 * which gates `isAdminRole`). It WRITES NOTHING, classifies nothing — it reads
 * `jobs/<jobId>/scope-reconciliation.json` (produced by reconciliation-producer)
 * and shapes the confirmed RAG status + findings + per-clause classifications
 * for review.
 *
 * The status + findings shown are the CONFIRMED snapshot (what the office last
 * confirmed against the then-current scope) — the same status/warnings the
 * producer persisted, never re-derived here from live scope, so the page can't
 * silently disagree with what was confirmed. The response is an explicit field
 * allowlist, never a raw spread of the persisted envelope.
 */

/** A serialisable finding for the review list (the persisted warnings snapshot). */
export interface ScopeFindingView {
  key: string;
  kind: string;
  severity: string;
  clauseId: string | null;
  message: string;
}

/** One clause's confirmed classification, summarised for the review table. */
export interface ScopeClauseView {
  clauseId: string;
  classification: ScopeClassification;
  warningText: string | null;
  note: string | null;
  boqLineCount: number;
  deliveredByCount: number;
  requiredEvidenceCount: number;
}

export interface ScopeReconciliationCounts {
  clauses: number;
  classified: number;
  unclassified: number;
  openFindings: number;
  redFindings: number;
  amberFindings: number;
}

export type ScopeReconciliationView =
  /** No reconciliation confirmed yet for this job. */
  | { ok: true; jobId: string; status: "missing" }
  /** The artifact exists but failed to parse — surfaced, never silently empty. */
  | { ok: true; jobId: string; status: "unreadable" }
  /** Confirmed — the RAG status, the findings snapshot and the clause table. */
  | {
      ok: true;
      jobId: string;
      status: "reconciled";
      rag: ReconciliationStatus;
      quoteId: string | null;
      confirmedBy: string | null;
      confirmedAt: string | null;
      updatedAt: string;
      counts: ScopeReconciliationCounts;
      clauses: ScopeClauseView[];
      findings: ScopeFindingView[];
    };

export interface ReconciliationReadDeps {
  /** Reads the raw persisted artifact for a job, or null when absent. */
  readRaw(jobId: string): Promise<unknown>;
}

/** Production deps — reads the real Blob store. */
export function blobReconciliationReadDeps(): ReconciliationReadDeps {
  return {
    async readRaw(jobId) {
      return readJsonBlob<unknown>(scopeReconciliationKey(jobId), null);
    },
  };
}

function toView(jobId: string, persisted: PersistedScopeReconciliation): ScopeReconciliationView {
  const rec = persisted.reconciliation;
  const classified = rec.clauseClassifications.filter((c) => c.classification !== "unclear").length;
  const unclassified = rec.clauseClassifications.length - classified;
  const redFindings = persisted.warnings.filter((w) => w.severity === "red").length;
  const amberFindings = persisted.warnings.filter((w) => w.severity === "amber").length;

  return {
    ok: true,
    jobId,
    status: "reconciled",
    rag: persisted.status,
    quoteId: rec.quoteId ?? null,
    confirmedBy: persisted.confirmedBy ?? null,
    confirmedAt: persisted.confirmedAt ?? null,
    updatedAt: persisted.updatedAt,
    counts: {
      clauses: rec.clauseClassifications.length,
      classified,
      unclassified,
      openFindings: persisted.warnings.length,
      redFindings,
      amberFindings,
    },
    clauses: rec.clauseClassifications.map((c) => ({
      clauseId: c.clauseId,
      classification: c.classification,
      warningText: c.warningText ?? null,
      note: c.note ?? null,
      boqLineCount: c.boqLineRefs.length,
      deliveredByCount: c.deliveredBy.length,
      requiredEvidenceCount: c.requiredEvidence.length,
    })),
    findings: persisted.warnings.map((w) => ({
      key: w.key,
      kind: w.kind,
      severity: w.severity,
      clauseId: w.clauseId ?? null,
      message: w.message,
    })),
  };
}

/** Read + shape the confirmed reconciliation for a job. Never throws on a
 *  missing/invalid artifact — returns a typed `missing` / `unreadable`. */
export async function runScopeReconciliationView(
  deps: ReconciliationReadDeps,
  jobId: string,
): Promise<ScopeReconciliationView> {
  let raw: unknown;
  try {
    raw = await deps.readRaw(jobId);
  } catch {
    return { ok: true, jobId, status: "unreadable" };
  }
  if (raw == null) return { ok: true, jobId, status: "missing" };
  const parsed = PersistedScopeReconciliationSchema.safeParse(raw);
  if (!parsed.success) return { ok: true, jobId, status: "unreadable" };
  return toView(jobId, parsed.data);
}
