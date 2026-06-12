/**
 * PDF.js CDN loader (#379) — the same pinned legacy build + worker the
 * deleted admin estate used for the takeoff pipeline, as a module-level
 * singleton. Script-injected from the CDN instead of bundled: pdfjs-dist
 * is ~1.5 MB, only the upload flow needs it, and the worker file resolves
 * itself relative to the same base with zero Next bundler config.
 *
 * Browser-only — callers live in "use client" components behind user
 * interaction, never during SSR.
 */

const PDFJS_VER = "4.0.379";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/legacy/build`;

export interface PdfJsPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

export interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
}

interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: ArrayBuffer }): { promise: Promise<PdfJsDocument> };
}

declare global {
  interface Window {
    pdfjsLib?: PdfJsLib;
  }
}

let loading: Promise<PdfJsLib> | null = null;

export function loadPdfJs(): Promise<PdfJsLib> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("PDF.js is browser-only"));
  }
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (loading) return loading;
  loading = new Promise<PdfJsLib>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${PDFJS_BASE}/pdf.min.js`;
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) {
        loading = null;
        reject(new Error("PDF.js loaded but pdfjsLib missing"));
        return;
      }
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
      resolve(lib);
    };
    s.onerror = () => {
      loading = null;
      reject(new Error("PDF.js failed to load — check your connection"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
