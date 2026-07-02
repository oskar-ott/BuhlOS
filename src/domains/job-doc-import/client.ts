import {
  AttachWorkbookResponseSchema,
  BoqImportPreviewSchema,
  CostImportResponseSchema,
  WorkbookImportRecordSchema,
  WorkbookImportResponseSchema,
  type AttachWorkbookResponse,
  type BoqImportPreview,
  type CostImportSummary,
  type WorkbookClassification,
  type WorkbookImportRecord,
} from "./schema";

/**
 * Browser client for the read-only BOQ import preview (#365). Reads the chosen
 * .xlsx as a dataUrl (the same upload pattern as /api/plans + /api/quote-documents),
 * POSTs it, and validates the response at the boundary. Returns a preview only —
 * it never asks the server to write anything.
 */
export async function requestBoqImportPreview(file: File): Promise<BoqImportPreview> {
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch("/api/job-doc-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Import preview failed (${res.status})`);
  }
  const json = (await res.json()) as { preview?: unknown };
  return BoqImportPreviewSchema.parse(json.preview);
}

export interface BoqJobCreated {
  jobId: string;
  job: { id: string; name: string; status: string };
  costBasis: { lines: number; total: number; reconciles: boolean | null };
}

/**
 * Create a real DRAFT job from a reviewed BOQ workbook (#365 write-half). Re-
 * uploads the workbook — the server re-parses it, so the client's on-screen
 * preview is never trusted as the source of truth — plus the human-entered job
 * name. Returns the new job id + a small cost-basis summary.
 */
export async function createJobFromBoqImport(
  file: File,
  name: string
): Promise<BoqJobCreated> {
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch("/api/job-doc-import?action=create-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, dataUrl, name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Create job failed (${res.status})`);
  }
  return (await res.json()) as BoqJobCreated;
}

/**
 * Read back a job's BOQ cost basis for the hub card (#365). Resolves to
 * { ok:false } on any non-200 (incl. the dark-flag 404) or a malformed payload
 * so the card simply stays hidden; otherwise { ok:true, costImport } where
 * costImport is null for a job that wasn't created from a BOQ import.
 */
export async function fetchJobCostImport(
  jobId: string
): Promise<{ ok: boolean; costImport: CostImportSummary | null }> {
  const res = await fetch(`/api/job-doc-import?jobId=${encodeURIComponent(jobId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, costImport: null };
  const parsed = CostImportResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, costImport: null };
  return { ok: true, costImport: parsed.data.costImport };
}


// ── #365 quote-side workbook import (attach + review) ───────────────────────

/**
 * Import the workbook AGAINST A QUOTE (existing `quoteId`, or a fresh draft
 * named `quoteName`). The server re-parses with the provenance/health parser,
 * stores the import record on the quote (re-upload supersedes with a kept
 * record) and materialises the base-classified lines into import-owned quote
 * sections.
 */
export async function attachWorkbookToQuote(
  file: File,
  target: { quoteId: string } | { quoteName: string }
): Promise<AttachWorkbookResponse> {
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch("/api/job-doc-import?action=attach-to-quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, dataUrl, ...target }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Workbook import failed (${res.status})`);
  }
  return AttachWorkbookResponseSchema.parse(await res.json());
}

/**
 * Read a quote's workbook-import record for the review card. Resolves to
 * { ok:false } on any non-200 (incl. the dark-flag 404) or a malformed payload
 * so the card simply stays hidden; `workbookImport` is null for a quote with
 * no import.
 */
export async function fetchQuoteWorkbookImport(
  quoteId: string
): Promise<{ ok: boolean; workbookImport: WorkbookImportRecord | null }> {
  const res = await fetch(`/api/job-doc-import?quoteId=${encodeURIComponent(quoteId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, workbookImport: null };
  const parsed = WorkbookImportResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, workbookImport: null };
  return { ok: true, workbookImport: parsed.data.workbookImport };
}

async function postReviewAction(
  action: string,
  payload: Record<string, unknown>
): Promise<WorkbookImportRecord> {
  const res = await fetch(`/api/job-doc-import?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${action} failed (${res.status})`);
  }
  const json = (await res.json()) as { workbookImport?: unknown };
  return WorkbookImportRecordSchema.parse(json.workbookImport);
}

/** Human-confirm (or re-classify) one imported line. */
export function confirmWorkbookClassification(
  quoteId: string,
  lineId: string,
  classification: WorkbookClassification
): Promise<WorkbookImportRecord> {
  return postReviewAction("confirm-classification", { quoteId, lineId, classification });
}

/** Resolve or waive one named health finding. */
export function resolveWorkbookFinding(
  quoteId: string,
  findingId: string,
  resolution: "resolved" | "waived",
  reason?: string
): Promise<WorkbookImportRecord> {
  return postReviewAction("resolve-finding", { quoteId, findingId, resolution, reason });
}

/** Mark the import review complete (the counts at completion are stamped —
 *  never a fake clean state). */
export function completeWorkbookReview(quoteId: string): Promise<WorkbookImportRecord> {
  return postReviewAction("complete-review", { quoteId });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
