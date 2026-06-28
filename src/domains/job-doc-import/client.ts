import {
  BoqImportPreviewSchema,
  CostImportResponseSchema,
  type BoqImportPreview,
  type CostImportSummary,
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
