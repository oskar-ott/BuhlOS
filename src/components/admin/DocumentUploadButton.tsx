"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { setPlanPages, suggestDocMetadata, uploadDocument } from "@/domains/documents/client";
import { DOCUMENT_CATEGORIES, DOCUMENT_DISCIPLINES } from "@/domains/documents/schema";
import { categoryLabel } from "@/domains/documents/format";
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
 *   1. Pick file(s) (PDF/image, ≤ 25 MB each) + metadata. ONE file keeps the
 *      full per-file form (title / drawing number / revision — unchanged).
 *      SEVERAL files switch to batch mode: one shared category (+ discipline),
 *      titles default to each file's name on the register, and the per-file
 *      drawing number / revision stay blank (they're per-drawing facts — edit
 *      them on the register afterwards, never invented here).
 *   2. POST each dataUrl SEQUENTIALLY (bounded memory; the serverless body
 *      cap applies per call). A same-number current revision is auto-
 *      superseded by the server, which says so via `revisionWarning`.
 *   3. PDFs only: render each page to PNG in-browser (PDF.js @ 180 DPI,
 *      same recipe as the deleted estate) and register them one call at a
 *      time — the takeoff + overlay pipeline depends on these per-page
 *      PNGs, and this was their only ingestion path. Page-prep failure
 *      degrades honestly: the document is already saved; the viewer falls
 *      back to the raw file.
 *   4. Batch mode finishes with a PER-FILE result list (uploaded / failed
 *      with the reason) — a mid-batch failure never hides what did land.
 *
 * The server is the permission gate (admin tier any job, LH their assigned
 * jobs) — a 403 surfaces in the error banner / per-file result.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const RENDER_DPI = 180;

interface Props {
  jobId: string;
  /** Preselected category — lets the certificates/safety sections reuse this. */
  defaultCategory?: (typeof DOCUMENT_CATEGORIES)[number];
  /** Render the form open immediately (render tests only). */
  defaultOpen?: boolean;
  /**
   * AI metadata auto-fill (behind the `ai_drawings` flag — the caller passes
   * the resolved boolean). When true, single-file non-revise mode shows a
   * "Fill from file" button that reads the picked file and proposes the
   * metadata fields; it never auto-submits. Off in batch + revise mode.
   */
  aiAutofill?: boolean;
  /**
   * #299: "New revision" mode. Names the predecessor register row — the
   * server inherits drawingNumber/discipline/title/level and supersedes it
   * atomically, so the form shrinks to file + revision + what-changed.
   * Single-file by nature (one predecessor).
   */
  revises?: {
    id: string;
    drawingNumber?: string;
    title?: string;
    revision?: string;
  };
}

interface BatchResult {
  name: string;
  ok: boolean;
  error?: string;
  pagesPrepared?: number | null;
  pagePrepError?: string | null;
  revisionWarning?: string | null;
}

type Phase =
  | { kind: "form" }
  | { kind: "uploading" }
  | { kind: "rendering"; page: number; total: number }
  | {
      kind: "batch";
      index: number; // 1-based file position
      total: number;
      stage: "uploading" | "rendering";
      page?: number;
      pages?: number;
    }
  | {
      kind: "done";
      revisionWarning: string | null;
      /** #299: assigned field workers pushed about the revision. */
      notified: number | null;
      pagesPrepared: number | null;
      pagePrepError: string | null;
    }
  | { kind: "batchDone"; results: BatchResult[] };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

/** Plain-sentence copy for the AI auto-fill failure statuses. */
function autofillErrorFor(status: number): string {
  if (status === 402) return "This job has reached its AI budget — fill the fields in by hand.";
  if (status === 403) return "You don't have access to auto-fill on this job.";
  if (status === 413) return "That file is too big to read — fill the fields in by hand.";
  if (status === 503) return "AI isn't set up on this server — fill the fields in by hand.";
  return "Couldn't read the file this time — fill the fields in by hand.";
}

export function DocumentUploadButton({
  jobId,
  defaultCategory = "plan",
  defaultOpen = false,
  aiAutofill = false,
  revises,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(defaultCategory);
  const [drawingNumber, setDrawingNumber] = useState("");
  const [discipline, setDiscipline] = useState<string>("electrical");
  const [revision, setRevision] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // AI auto-fill (single-file non-revise only): busy flag, inline error and a
  // note shown once a suggestion has filled the form.
  const [autofilling, setAutofilling] = useState(false);
  const [autofillError, setAutofillError] = useState<string | null>(null);
  const [autofilled, setAutofilled] = useState(false);
  const reviseName = revises ? (revises.drawingNumber || revises.title || "this drawing") : null;

  const busy = phase.kind === "uploading" || phase.kind === "rendering" || phase.kind === "batch";
  const batchMode = !revises && files.length > 1;

  function reset() {
    setPhase({ kind: "form" });
    setFiles([]);
    setTitle("");
    setCategory(defaultCategory);
    setDrawingNumber("");
    setRevision("");
    setChangeSummary("");
    setErrorMessage(null);
    setAutofilling(false);
    setAutofillError(null);
    setAutofilled(false);
  }

  /**
   * AI auto-fill: read the picked file and PROPOSE the metadata fields. Fills
   * only what the suggestion offers (a field the model omits is left as the
   * admin left it) and never submits — the admin still checks and saves. The
   * error map keeps each failure a plain sentence.
   */
  async function fillFromFile() {
    const file = files[0];
    if (!file) return;
    setAutofillError(null);
    setAutofilled(false);
    setAutofilling(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await suggestDocMetadata(jobId, {
        dataUrl,
        fileName: file.name,
        mimeType: file.type || undefined,
      });
      if (!res.ok) {
        setAutofillError(autofillErrorFor(res.error.status));
        return;
      }
      const s = res.data.suggestion;
      if (s.title) setTitle(s.title);
      if (s.category) setCategory(s.category);
      if (s.discipline) setDiscipline(s.discipline);
      if (s.drawingNumber) setDrawingNumber(s.drawingNumber);
      if (s.revision) setRevision(s.revision);
      setAutofilled(true);
    } catch {
      setAutofillError("Couldn't read the file to fill from it.");
    } finally {
      setAutofilling(false);
    }
  }

  function close() {
    if (busy) return; // an in-flight upload shouldn't be abandoned silently
    setOpen(false);
    reset();
  }

  /**
   * PDFs: per-page PNG ingestion for the viewer/takeoff pipeline. Best-effort
   * enhancement — the document is already saved; the viewer copes without it.
   */
  async function preparePdfPages(
    file: File,
    planId: string,
    onPage: (page: number, total: number) => void,
  ): Promise<{ pagesPrepared: number | null; pagePrepError: string | null }> {
    if (file.type !== "application/pdf") return { pagesPrepared: null, pagePrepError: null };
    try {
      const pdfjs = await loadPdfJs();
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        onPage(i, pdf.numPages);
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
        const registered = await setPlanPages(jobId, planId, {
          pageIndex: i - 1,
          pngDataUrl,
        });
        if (!registered.ok) throw new Error(registered.error.message);
      }
      return { pagesPrepared: pdf.numPages, pagePrepError: null };
    } catch (err) {
      return {
        pagesPrepared: null,
        pagePrepError: err instanceof Error ? err.message : "page render failed",
      };
    }
  }

  async function submit() {
    const file = files[0];
    if (!file) return;
    setErrorMessage(null);
    if (file.size > MAX_BYTES) {
      setErrorMessage("File too large — 25 MB max.");
      return;
    }
    setPhase({ kind: "uploading" });
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await uploadDocument(
        jobId,
        revises
          ? {
              // Revision mode: identity fields inherit server-side from the
              // predecessor — only what's NEW travels.
              dataUrl,
              fileName: file.name,
              revisesPlanId: revises.id,
              revision: revision.trim(),
              changeSummary: changeSummary.trim(),
            }
          : {
              dataUrl,
              fileName: file.name,
              title: title.trim(),
              category,
              drawingNumber: category === "plan" ? drawingNumber.trim() : "",
              revision: category === "plan" ? revision.trim() : "",
              discipline: category === "plan" ? discipline : undefined,
            },
      );
      if (!uploaded.ok) {
        setPhase({ kind: "form" });
        setErrorMessage(uploaded.error.message);
        return;
      }

      const prep = await preparePdfPages(file, uploaded.data.plan.id, (page, total) =>
        setPhase({ kind: "rendering", page, total }),
      );

      setPhase({
        kind: "done",
        revisionWarning: uploaded.data.revisionWarning,
        notified: uploaded.data.notified ?? null,
        pagesPrepared: prep.pagesPrepared,
        pagePrepError: prep.pagePrepError,
      });
      router.refresh();
    } catch (err) {
      setPhase({ kind: "form" });
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
    }
  }

  /**
   * Batch mode: upload the selected files one after another (bounded memory,
   * one serverless body per call). A failure records honestly and the batch
   * carries on — what landed is never hidden by what didn't.
   */
  async function submitBatch() {
    if (files.length < 2) return;
    setErrorMessage(null);
    const results: BatchResult[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      setPhase({ kind: "batch", index: i + 1, total: files.length, stage: "uploading" });
      if (file.size > MAX_BYTES) {
        results.push({ name: file.name, ok: false, error: "too large — 25 MB max" });
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const uploaded = await uploadDocument(jobId, {
          dataUrl,
          fileName: file.name,
          // Title defaults to the file name on the register (displayTitle);
          // drawing number / revision are per-drawing facts — never invented
          // in a batch. Edit them on the register afterwards.
          title: "",
          category,
          drawingNumber: "",
          revision: "",
          discipline: category === "plan" ? discipline : undefined,
        });
        if (!uploaded.ok) {
          results.push({ name: file.name, ok: false, error: uploaded.error.message });
          continue;
        }
        const prep = await preparePdfPages(file, uploaded.data.plan.id, (page, pages) =>
          setPhase({ kind: "batch", index: i + 1, total: files.length, stage: "rendering", page, pages }),
        );
        results.push({
          name: file.name,
          ok: true,
          pagesPrepared: prep.pagesPrepared,
          pagePrepError: prep.pagePrepError,
          revisionWarning: uploaded.data.revisionWarning,
        });
      } catch (err) {
        results.push({
          name: file.name,
          ok: false,
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    }
    setPhase({ kind: "batchDone", results });
    router.refresh();
  }

  const inputClass =
    "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm";

  const doneOk = phase.kind === "batchDone" ? phase.results.filter((r) => r.ok).length : 0;

  return (
    <>
      <Button
        size="sm"
        variant={revises ? "secondary" : "primary"}
        onClick={() => setOpen(true)}
        data-testid={revises ? "document-revise-open" : "document-upload-open"}
      >
        {revises ? "New revision" : "Upload a document"}
      </Button>

      {open ? (
        <Modal
          open
          onClose={close}
          title={revises ? `New revision — ${reviseName}` : "Add a document"}
          className="max-w-lg"
        >
          <div className="space-y-4 text-sm">
            {phase.kind === "done" ? (
              <div className="space-y-3" data-testid="document-upload-done">
                <p className="text-text">Uploaded and marked current.</p>
                {phase.notified !== null && phase.notified > 0 ? (
                  <p className="text-text-muted" data-testid="document-revise-notified">
                    {phase.notified} assigned {phase.notified === 1 ? "worker" : "workers"} notified
                    in Phil — acknowledgements show on the register.
                  </p>
                ) : null}
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
                  <p className="text-text-muted" role="status">
                    Saved. Couldn&rsquo;t pre-render the pages for the plan viewer — it&rsquo;ll show
                    the file itself.
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
            ) : phase.kind === "batchDone" ? (
              <div className="space-y-3" data-testid="document-upload-batch-done">
                <p className="text-text">
                  {doneOk} of {phase.results.length} document{phase.results.length === 1 ? "" : "s"} uploaded.
                </p>
                <ul className="space-y-1.5">
                  {phase.results.map((r) => (
                    <li key={r.name} className="rounded-card border border-border px-3 py-2">
                      <span className="block truncate font-medium text-text">
                        {r.ok ? "✓" : "✗"} {r.name}
                      </span>
                      {!r.ok && r.error ? (
                        <span className="block text-[12px] text-state-danger">{r.error}</span>
                      ) : null}
                      {r.ok && r.pagesPrepared != null ? (
                        <span className="block text-[12px] text-text-muted">
                          {r.pagesPrepared} page{r.pagesPrepared === 1 ? "" : "s"} prepared
                        </span>
                      ) : null}
                      {r.ok && r.pagePrepError ? (
                        <span className="block text-[12px] text-text-muted">
                          Saved. Couldn&rsquo;t pre-render the pages — the viewer will show the file itself.
                        </span>
                      ) : null}
                      {r.ok && r.revisionWarning ? (
                        <span className="block text-[12px] text-state-warning">{r.revisionWarning}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={close}>
                    Close
                  </Button>
                  <Button className="flex-1" onClick={reset}>
                    Upload more
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
                  <span className="text-text-muted">
                    {revises ? "File (PDF or image, up to 25 MB)" : "Files (PDF or image, up to 25 MB each)"}
                  </span>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    multiple={!revises}
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    className="mt-1 block w-full text-sm"
                    data-testid="document-upload-file"
                  />
                </label>

                {revises ? (
                  <>
                    <p className="rounded-card bg-surface-subtle px-3 py-2 text-text-muted">
                      Inherits {reviseName}&rsquo;s details and supersedes
                      {revises.revision ? ` Rev ${revises.revision}` : " the current revision"} in
                      one step. Assigned workers get a push and acknowledge in Phil.
                    </p>
                    <label className="block">
                      <span className="text-text-muted">New revision</span>
                      <input
                        type="text"
                        value={revision}
                        onChange={(e) => setRevision(e.target.value)}
                        placeholder={revises.revision ? `after ${revises.revision}` : "e.g. C"}
                        className={inputClass}
                        data-testid="document-revise-revision"
                      />
                    </label>
                    <label className="block">
                      <span className="text-text-muted">What changed (workers see this)</span>
                      <textarea
                        value={changeSummary}
                        onChange={(e) => setChangeSummary(e.target.value)}
                        placeholder="e.g. Unit 4 power layout changed — extra circuit in the kitchen"
                        rows={3}
                        className="mt-1 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
                        data-testid="document-revise-summary"
                      />
                    </label>
                  </>
                ) : null}

                {!revises && batchMode ? (
                  <>
                    <ul
                      className="max-h-40 space-y-1 overflow-y-auto rounded-card border border-border p-2"
                      data-testid="document-upload-batch-list"
                    >
                      {files.map((f) => (
                        <li key={f.name} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-text">{f.name}</span>
                          <span className="shrink-0 font-mono text-[12px] text-text-muted">
                            {(f.size / (1024 * 1024)).toFixed(1)} MB
                          </span>
                        </li>
                      ))}
                    </ul>
                    <label className="block">
                      <span className="text-text-muted">Category (applies to all)</span>
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className={inputClass}
                        data-testid="document-upload-category"
                      >
                        {DOCUMENT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {categoryLabel(c)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {category === "plan" ? (
                      <label className="block">
                        <span className="text-text-muted">Discipline (applies to all)</span>
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
                    <p className="rounded-card bg-surface-subtle px-3 py-2 text-[12px] text-text-muted">
                      Each file&rsquo;s title defaults to its file name, and drawing number /
                      revision stay blank — they&rsquo;re per-drawing facts, so set them on the
                      register afterwards rather than guessing here.
                    </p>
                  </>
                ) : null}

                {!revises && !batchMode ? (
                <>
                {aiAutofill && files.length > 0 ? (
                  <div className="space-y-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void fillFromFile()}
                      disabled={autofilling || busy}
                      data-testid="document-autofill"
                    >
                      {autofilling ? "Reading…" : "✨ Fill from file"}
                    </Button>
                    {autofillError ? (
                      <p className="text-xs text-state-danger" role="alert">
                        {autofillError}
                      </p>
                    ) : null}
                    {autofilled && !autofillError ? (
                      <p className="text-xs text-text-muted" role="status">
                        AI suggested from the file — check before saving.
                      </p>
                    ) : null}
                  </div>
                ) : null}
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
                    {/* canonical labels (format.ts) — "contract" renders as
                        "Contract / SOW" (#373), not a bare capitalisation */}
                    {DOCUMENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {categoryLabel(c)}
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
                </>
                ) : null}

                {phase.kind === "rendering" ? (
                  <p className="text-text-muted" role="status">
                    Preparing page {phase.page} of {phase.total} for the viewer…
                  </p>
                ) : null}
                {phase.kind === "batch" ? (
                  <p className="text-text-muted" role="status" data-testid="document-upload-batch-progress">
                    File {phase.index} of {phase.total}
                    {phase.stage === "rendering" && phase.page && phase.pages
                      ? ` — preparing page ${phase.page} of ${phase.pages}…`
                      : " — uploading…"}
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={close} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => void (batchMode ? submitBatch() : submit())}
                    disabled={busy || files.length === 0}
                    data-testid="document-upload-submit"
                  >
                    {phase.kind === "uploading"
                      ? "Uploading…"
                      : phase.kind === "rendering"
                        ? "Preparing pages…"
                        : phase.kind === "batch"
                          ? `Uploading ${phase.index}/${phase.total}…`
                          : batchMode
                            ? `Upload ${files.length} documents`
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
