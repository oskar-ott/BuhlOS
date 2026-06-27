import { BoqImportPreviewSchema, type BoqImportPreview } from "./schema";

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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
