import { loadPdfJs } from "@/lib/pdfjs-loader";
import { setPlanPages } from "./client";

/**
 * Plan page preparation — renders a document into per-page PNGs and registers
 * them via POST /api/plans?action=set-pages, which is what makes a document
 * ANALYSABLE (the analysis panel and the plan viewer both run off page images,
 * never the raw file).
 *
 * Shared by two callers:
 *   - DocumentUploadButton — prep at upload time (the happy path);
 *   - SheetUnderstandingPanel — RETRO prep for documents that have no pages
 *     (uploads made while pdf.js was broken pre-#867, and image files, which
 *     the uploader never prepped at all).
 *
 * Browser-only (canvas + pdf.js), same as the uploader has always been.
 * Failures THROW with a plain message — callers surface it honestly; the
 * document itself is already saved either way.
 */

/** Render scale for PDF pages (matches the uploader's historical output). */
export const PLAN_RENDER_DPI = 180;

/** Longest-side cap for image documents — keeps the PNG well under the
 *  server's per-page byte cap while staying readable for analysis. */
const IMAGE_MAX_SIDE_PX = 4200;

async function registerPage(
  jobId: string,
  planId: string,
  pageIndex: number,
  pngDataUrl: string,
): Promise<void> {
  const registered = await setPlanPages(jobId, planId, { pageIndex, pngDataUrl });
  if (!registered.ok) throw new Error(registered.error.message);
}

/** Fetch the stored document file (public blob URL) as bytes. */
export async function fetchDocumentBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`couldn't fetch the file (${res.status})`);
  return res.arrayBuffer();
}

/**
 * Render every page of a PDF to a PNG and register each with the server.
 * Returns the page count; throws on the first failure.
 */
export async function preparePdfPlanPages(
  jobId: string,
  planId: string,
  data: ArrayBuffer,
  onPage?: (page: number, total: number) => void,
): Promise<number> {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    onPage?.(i, pdf.numPages);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: PLAN_RENDER_DPI / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const pngDataUrl = canvas.toDataURL("image/png");
    canvas.width = 0;
    canvas.height = 0;
    await registerPage(jobId, planId, i - 1, pngDataUrl);
  }
  return pdf.numPages;
}

/**
 * An image document IS its one page: re-encode it to a (size-capped) PNG and
 * register it as page 0 — after this, image plans are analysable exactly like
 * a rendered PDF page. Returns 1; throws on failure.
 */
export async function prepareImagePlanPage(
  jobId: string,
  planId: string,
  blob: Blob,
): Promise<number> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, IMAGE_MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pngDataUrl = canvas.toDataURL("image/png");
    canvas.width = 0;
    canvas.height = 0;
    await registerPage(jobId, planId, 0, pngDataUrl);
    return 1;
  } finally {
    bitmap.close();
  }
}
