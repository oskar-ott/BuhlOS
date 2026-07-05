/**
 * PDF.js loader — SELF-HOSTED under /public/pdfjs, version-pinned (#379).
 *
 * Was script-injected from jsdelivr, which was fragile two ways: it broke on
 * any network that blocks the CDN, AND the pinned URL
 * (pdfjs-dist@4.0.379/legacy/build/pdf.min.js) 404'd outright — 4.0.379 ships
 * ESM only, there is no UMD `pdf.min.js` that sets `window.pdfjsLib`. So the
 * whole page-prep path was dead, not merely CDN-dependent.
 *
 * Now the pinned legacy build (`pdf.min.mjs` + `pdf.worker.min.mjs`) is
 * committed under public/pdfjs and served same-origin. Because the build is
 * ESM, a classic <script> can't create the global — we inject a
 * `type="module"` shim that dynamically imports the local module and hangs
 * the namespace on `window.pdfjsLib`, keeping the rest of the contract
 * identical: a module-level singleton, the workerSrc pointing at the
 * co-located worker, and callers still awaiting `loadPdfJs()`.
 *
 * The files are pinned to the pdfjs-dist devDependency (4.0.379). To bump:
 * change the version there and re-copy both files from
 * node_modules/pdfjs-dist/legacy/build.
 *
 * Browser-only — callers live in "use client" components behind user
 * interaction, never during SSR.
 */

const PDFJS_BASE = "/pdfjs";

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
    // A module shim: DYNAMICALLY import the self-hosted ESM build so a failed
    // fetch/parse (missing file, broken deploy) becomes a caught rejection we
    // can surface — a static `import … from` inside an inline module would
    // reject the module's own evaluation WITHOUT firing the element's onerror,
    // hanging this promise forever. We publish the namespace on
    // window.pdfjsLib and signal via one-shot ready/error events, keeping
    // callers' `await loadPdfJs()` contract intact.
    window.addEventListener(
      "pdfjs:ready",
      () => {
        const lib = window.pdfjsLib;
        if (!lib) {
          loading = null;
          reject(new Error("PDF.js loaded but pdfjsLib missing"));
          return;
        }
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
        resolve(lib);
      },
      { once: true },
    );
    window.addEventListener(
      "pdfjs:error",
      (e: Event) => {
        loading = null;
        const detail = (e as CustomEvent).detail;
        reject(
          new Error(typeof detail === "string" && detail ? detail : "PDF.js failed to load"),
        );
      },
      { once: true },
    );
    const s = document.createElement("script");
    s.type = "module";
    s.textContent = `import("${PDFJS_BASE}/pdf.min.mjs").then(function (m) {
  window.pdfjsLib = m;
  window.dispatchEvent(new Event("pdfjs:ready"));
}).catch(function (err) {
  window.dispatchEvent(new CustomEvent("pdfjs:error", { detail: "PDF.js failed to load: " + ((err && err.message) || err) }));
});`;
    // Belt-and-suspenders: if the inline module itself can't be evaluated.
    s.onerror = () => window.dispatchEvent(new Event("pdfjs:error"));
    document.head.appendChild(s);
  });
  return loading;
}
