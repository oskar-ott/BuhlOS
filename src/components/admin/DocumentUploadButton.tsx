"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { setPlanPages, uploadDocument } from "@/domains/documents/client";
import { DOCUMENT_CATEGORIES, DOCUMENT_DISCIPLINES } from "@/domains/documents/schema";
import { loadPdfJs } from "@/lib/pdfjs-loader";

/**
 * Document upload (#379) — restores the capability the legacy cutover
 * deleted: `POST /api/plans` kept working, but no surface could call it.
 *
 * REUSABLE BY DESIGN: #219 (safety docs) and #231 (certificates) mount this
 * same button with a different `defaultCategory` instead of building second
 * uploaders — keep it shell-neutral (no page-specific assumptions).
 *
 * Flow:
 *   1. Pick a file (PDF/image, ≤ 25 MB) + metadata. Drawing number /
 *      revision only apply to drawings — shown for the plan category.
 *   2. POST the dataUrl. A same-number current revision is auto-superseded
 *      by the server, which says so via `revisionWarning` (surfaced as a
 *      notice — it's a statement of what happened, not a question).
 *   3. PDFs only: render each page to PNG in-browser (PDF.js @ 180 DPI,
 *      same recipe as the deleted estate) and register them one call at a
 *      time — the takeoff + overlay pipeline depends on these per-page
 *      PNGs, and this was their only ingestion path. Page-prep failure
 *      degrades honestly: the document is already saved; the viewer falls
 *      back to the raw file.
 *
 * The server is the permission gate (admin tier any job, LH their assigned
 * jobs) — a 403 surfaces in the error banner.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const RENDER_DPI = 180;

interface Props {
  jobId: string;
  /** Preselected category — lets the certificates/safety sections reuse this. */
  defaultCategory?: (typeof DOCUMENT_CATEGORIES)[number];
  /** Render the form open immediately (render tests only). */
  defaultOpen?: boolean;
}

type Phase =
  | { kind: "form" }
  | { kind: "uploading" }
  | { kind: "rendering"; page: number; total: number }
  | {
      kind: "done";
      revisionWarning: string | null;
      pagesPrepared: number | null;
      pagePrepError: string | null;
    };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

export function DocumentUploadButton({ jobId, defaultCategory = "plan", defaultOpen = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(defaultCategory);
  const [drawingNumber, setDrawingNumber] = useState("");
  const [discipline, setDiscipline] = useState<string>("electrical");
  const [revision, setRevision] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const busy = phase.kind === "uploading" || phase.kind === "rendering";

  function reset() {
    setPhase({ kind: "form" });
    setFile(null);
    setTitle("");
    setCategory(defaultCategory);
    setDrawingNumber("");
    setRevision("");
    setErrorMessage(null);
  }

  function close() {
    if (busy) return; // an in-flight upload shouldn't be abandoned silently
    setOpen(false);
    reset();
  }

  async function submit() {
    if (!file) return;
    setErrorMessage(null);
    if (file.size > MAX_BYTES) {
      setErrorMessage("File too large — 25 MB max.");
      return;
    }
    setPhase({ kind: "uploading" });
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await uploadDocument(jobId, {
        dataUrl,
        fileName: file.name,
        title: title.trim(),
        category,
        drawingNumber: category === "plan" ? drawingNumber.trim() : "",
        revision: category === "plan" ? revision.trim() : "",
        discipline: category === "plan" ? discipline : undefined,
      });
      if (!uploaded.ok) {
        setPhase({ kind: "form" });
        setErrorMessage(uploaded.error.message);
        return;
      }

      // PDFs: per-page PNG ingestion for the viewer/takeoff pipeline.
      let pagesPrepared: number | null = null;
      let pagePrepError: string | null = null;
      if (file.type === "application/pdf") {
        try {
          const pdfjs = await loadPdfJs();
          const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
          for (let i = 1; i <= pdf.numPages; i++) {
            setPhase({ kind: "rendering", page: i, total: pdf.numPages });
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: RENDER_DPI / 72 });
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
            const registered = await setPlanPages(jobId, uploaded.data.plan.id, {
              pageIndex: i - 1,
              pngDataUrl,
            });
            if (!registered.ok) throw new Error(registered.error.message);
          }
          pagesPrepared = pdf.numPages;
        } catch (err) {
          // The document itself is saved — page prep is a best-effort
          // enhancement, and the viewer copes without it.
          pagePrepError = err instanceof Error ? err.message : "page render failed";
        }
      }

      setPhase({
        kind: "done",
        revisionWarning: uploaded.data.revisionWarning,
        pagesPrepared,
        pagePrepError,
      });
      router.refresh();
    } catch (err) {
      setPhase({ kind: "form" });
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
    }
  }

  const inputClass =
    "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm";

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="document-upload-open">
        Upload a document
      </Button>

      {open ? (
        <Modal open onClose={close} title="Upload a document" className="max-w-lg">
          <div className="space-y-4 text-sm">
            {phase.kind === "done" ? (
              <div className="space-y-3" data-testid="document-upload-done">
                <p className="text-text">Uploaded and marked current.</p>
                {phase.revisionWarning ? (
                  <p className="rounded-card border border-state-warning px-3 py-2 text-state-warning" role="status">
                    {phase.revisionWarning}
                  </p>
                ) : null}
                {phase.pagesPrepared !== null ? (
                  <p className="text-text-muted">
                    {phase.pagesPrepared} page{phase.pagesPrepared === 1 ? "" : "s"} prepared for
                    the viewer and takeoff.
                  </p>
                ) : null}
                {phase.pagePrepError ? (
                  <p className="rounded-card border border-state-warning px-3 py-2 text-state-warning" role="status">
                    The file is saved, but page preparation failed ({phase.pagePrepError}). The
                    viewer will show the raw file.
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={close}>
                    Close
                  </Button>
                  <Button className="flex-1" onClick={reset}>
                    Upload another
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {errorMessage ? (
                  <p className="rounded-card border border-state-danger px-3 py-2 text-state-danger" role="alert">
                    {errorMessage}
                  </p>
                ) : null}

                <label className="block">
                  <span className="text-text-muted">File (PDF or image, up to 25 MB)</span>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="mt-1 block w-full text-sm"
                    data-testid="document-upload-file"
                  />
                </label>

                <label className="block">
                  <span className="text-text-muted">Title</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Level 1 power layout"
                    className={inputClass}
                  />
                </label>

                <label className="block">
                  <span className="text-text-muted">Category</span>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className={inputClass}
                    data-testid="document-upload-category"
                  >
                    {DOCUMENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c[0]!.toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>

                {category === "plan" ? (
                  <label className="block">
                    <span className="text-text-muted">Discipline</span>
                    <select
                      value={discipline}
                      onChange={(e) => setDiscipline(e.target.value)}
                      className={inputClass}
                      data-testid="document-upload-discipline"
                    >
                      {DOCUMENT_DISCIPLINES.map((dd) => (
                        <option key={dd} value={dd}>
                          {dd[0]!.toUpperCase() + dd.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {category === "plan" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-text-muted">Drawing number</span>
                      <input
                        type="text"
                        value={drawingNumber}
                        onChange={(e) => setDrawingNumber(e.target.value)}
                        placeholder="E-101"
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="text-text-muted">Revision</span>
                      <input
                        type="text"
                        value={revision}
                        onChange={(e) => setRevision(e.target.value)}
                        placeholder="B"
                        className={inputClass}
                      />
                    </label>
                  </div>
                ) : null}

                {phase.kind === "rendering" ? (
                  <p className="text-text-muted" role="status">
                    Preparing page {phase.page} of {phase.total} for the viewer…
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={close} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => void submit()}
                    disabled={busy || !file}
                    data-testid="document-upload-submit"
                  >
                    {phase.kind === "uploading"
                      ? "Uploading…"
                      : phase.kind === "rendering"
                        ? "Preparing pages…"
                        : "Upload"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
