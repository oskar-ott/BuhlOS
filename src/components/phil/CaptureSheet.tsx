"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  createEvidence,
  uploadEvidencePhoto,
} from "@/domains/evidence/client";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import { resizeImageToDataUrl } from "@/domains/evidence/service";
import type {
  CreateEvidencePayload,
  EvidenceItem,
} from "@/domains/evidence/types";
import { visibleAreaGroups } from "@/domains/jobs/format";
import type { Job, JobStage } from "@/domains/jobs/types";
import { CapturePhotoPicker } from "./CapturePhotoPicker";
import { CaptureTargetPickers } from "./CaptureTargetPickers";
import { cn } from "@/lib/cn";

interface InitialContext {
  stage?: JobStage | null;
  areaId?: string | null;
}

interface Props {
  open: boolean;
  job: Job;
  initialContext?: InitialContext;
  onClose: () => void;
  /** Fired after a successful evidence POST so the parent can update
   *  the "Today's captures" strip without a re-fetch round-trip. */
  onCaptured: (item: EvidenceItem) => void;
  /** Fired on a failed submit so the parent can surface a persistent
   *  banner with retry context. */
  onFailed?: (message: string) => void;
}

type Phase =
  | { kind: "ready" }
  | { kind: "uploading" }
  | { kind: "pending_sync"; photoId: string; photoUrl: string; capturedAt: string }
  | { kind: "failed"; message: string };

/**
 * Phil evidence capture sheet — full-screen modal.
 *
 * Owns the capture lifecycle:
 *
 *   ready → uploading        → pending_sync → (closes; banner lands)
 *           (photo POST)        (evidence POST)
 *                ↘ failed         ↘ failed
 *
 * Sheet closes on first tap of Submit (per BUG-C-003 lesson). The
 * async result is reported via onCaptured / onFailed so the parent
 * decides where to surface the banner.
 *
 * Cross-ref:
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §6 + §7
 *   docs/rebuild-audit/27-interface-usability-pass.md §8.3 / §10
 *   src/domains/evidence/service.ts — resizeImageToDataUrl
 *   src/domains/evidence/client.ts — uploadEvidencePhoto + createEvidence
 *
 * Architecture rule: this file MUST live under src/components/phil/.
 * Co-locating client components under src/app/phil/jobs/[jobId]/
 * breaks the Next.js 15.5 RSC client manifest (D-26 binding rule).
 */
export function CaptureSheet({
  open,
  job,
  initialContext,
  onClose,
  onCaptured,
  onFailed,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [stage, setStage] = useState<JobStage | null>(initialContext?.stage ?? null);
  const [areaId, setAreaId] = useState<string | null>(initialContext?.areaId ?? null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [resizing, setResizing] = useState(false);

  // The sheet may unmount mid-flight (worker taps Cancel after Submit).
  // Track a per-submit signal so the async chain doesn't fire callbacks
  // for a stale submission.
  const submitSignalRef = useRef(0);

  const flatAreas = useMemo(
    () =>
      visibleAreaGroups(job.areaGroups).flatMap((g) =>
        (g.areas ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          groupName: g.name,
        }))
      ),
    [job.areaGroups]
  );

  // Sync initialContext when the sheet is re-opened with a different
  // parent selection (worker picked a new stage on the detail page).
  useEffect(() => {
    if (!open) return;
    if (initialContext?.stage !== undefined) {
      setStage((prev) => prev ?? initialContext.stage ?? null);
    }
    if (initialContext?.areaId !== undefined) {
      setAreaId((prev) => prev ?? initialContext.areaId ?? null);
    }
  }, [open, initialContext?.stage, initialContext?.areaId]);

  // Escape closes the sheet (cancel-without-discard semantics).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const busy = phase.kind === "uploading" || resizing;
  const noteLen = note.length;
  const canSubmit =
    !busy &&
    !!file &&
    !!dataUrl &&
    noteLen <= EVIDENCE_NOTE_MAX &&
    // taskId requires stage AND area — keep the picker logic consistent
    // with the server-side check in api/evidence.js.
    (!taskId || (!!stage && !!areaId));

  const handlePick = useCallback(async (next: File) => {
    setFile(next);
    setDataUrl(null);
    setResizing(true);
    try {
      const resized = await resizeImageToDataUrl(next, 1920, 0.7);
      setDataUrl(resized);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't read that photo.";
      setPhase({ kind: "failed", message: msg });
    } finally {
      setResizing(false);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !file || !dataUrl) return;
    // Capture the current submit signal — if the sheet closes and
    // re-opens before the chain resolves, the stale callback bails.
    submitSignalRef.current += 1;
    const mySignal = submitSignalRef.current;

    // Snapshot the inputs in case the user re-opens the sheet mid-flight
    // (the parent owns whether the sheet is mounted, so we don't want a
    // race between local state and the in-flight request).
    const captureJobId = job.id;
    const captureStage = stage;
    const captureAreaId = areaId;
    const captureTaskId = taskId;
    const captureNote = note.trim();
    const captureDataUrl = dataUrl;
    const captureClientCapturedAt = new Date().toISOString();

    setPhase({ kind: "uploading" });
    // Close on first tap (BUG-C-003 lesson). The banner lands when the
    // async chain resolves via onCaptured / onFailed.
    onClose();

    try {
      const photo = await uploadEvidencePhoto(captureJobId, captureDataUrl);
      if (mySignal !== submitSignalRef.current) return;
      if (!photo.ok) {
        const msg = `Couldn't upload photo (${photo.error.status || "network"}).`;
        setPhase({ kind: "failed", message: msg });
        onFailed?.(msg);
        return;
      }

      setPhase({
        kind: "pending_sync",
        photoId: photo.data.id,
        photoUrl: photo.data.url,
        capturedAt: photo.data.capturedAt,
      });

      const payload: CreateEvidencePayload = {
        kind: "photo",
        photoId: photo.data.id,
        photoUrl: photo.data.url,
        note: captureNote ? captureNote : null,
        stage: captureStage,
        areaId: captureAreaId,
        taskId: captureTaskId,
        clientCapturedAt: captureClientCapturedAt,
      };
      const created = await createEvidence(captureJobId, payload);
      if (mySignal !== submitSignalRef.current) return;
      if (!created.ok) {
        const msg = `Photo uploaded but evidence didn't save (${created.error.status || "network"}). Tap Retry.`;
        setPhase({ kind: "failed", message: msg });
        onFailed?.(msg);
        return;
      }

      // Clear local draft after a successful capture so the next
      // tap-to-open shows a clean sheet (per doc 29 §7.6 the worker
      // does NOT preserve a draft after a successful submit).
      setFile(null);
      setDataUrl(null);
      setNote("");
      setStage(initialContext?.stage ?? null);
      setAreaId(initialContext?.areaId ?? null);
      setTaskId(null);
      setPhase({ kind: "ready" });
      onCaptured(created.data.evidenceItem);
    } catch (e) {
      if (mySignal !== submitSignalRef.current) return;
      const msg = e instanceof Error ? e.message : "Couldn't save evidence. Try again.";
      setPhase({ kind: "failed", message: msg });
      onFailed?.(msg);
    }
  }, [
    canSubmit,
    file,
    dataUrl,
    job.id,
    stage,
    areaId,
    taskId,
    note,
    onClose,
    onCaptured,
    onFailed,
    initialContext?.stage,
    initialContext?.areaId,
  ]);

  if (!open) return null;

  return (
    // Safe-area-inset-bottom padding (Tailwind arbitrary value) so the
    // sticky submit bar isn't clipped by the iOS home indicator. Per
    // doc 27 §19.1 open question.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Capture evidence"
      className="fixed inset-0 z-50 flex flex-col bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {/* Header — sticky top so worker always knows where they are. */}
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold text-text">
            Capture evidence
          </h2>
          <p className="truncate text-xs text-text-muted">{job.name}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card",
            "text-text-muted hover:bg-surface-subtle"
          )}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-lg space-y-6">
          {phase.kind === "failed" ? (
            <p
              role="alert"
              className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {phase.message}
            </p>
          ) : null}

          <CapturePhotoPicker
            file={file}
            previewDataUrl={dataUrl}
            busy={busy}
            onPick={handlePick}
          />

          <div>
            <label htmlFor="capture-note" className="font-display text-sm font-semibold text-text">
              Note <span className="text-text-muted">(optional)</span>
            </label>
            <textarea
              id="capture-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              rows={3}
              maxLength={EVIDENCE_NOTE_MAX}
              placeholder="What does this photo show?"
              className={cn(
                "mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text",
                "placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
            />
            <p className="mt-1 text-right text-xs text-text-muted">
              {noteLen} / {EVIDENCE_NOTE_MAX}
            </p>
          </div>

          <CaptureTargetPickers
            job={job}
            flatAreas={flatAreas}
            stage={stage}
            areaId={areaId}
            taskId={taskId}
            busy={busy}
            onStageChange={(s) => {
              setStage(s);
              // Clearing the stage invalidates the task (which depends on stage).
              if (!s) setTaskId(null);
            }}
            onAreaChange={(a) => {
              setAreaId(a);
              if (!a) setTaskId(null);
            }}
            onTaskChange={setTaskId}
          />
        </div>
      </div>

      {/* Sticky footer — primary action at the bottom edge. */}
      <footer
        className={cn(
          "border-t border-border bg-surface-raised px-4 py-3",
          "shadow-[0_-1px_0_rgba(0,0,0,0.03)]"
        )}
      >
        <div className="mx-auto flex max-w-lg gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={onClose}
            disabled={busy}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn("flex-1", canSubmit ? "bg-accent-yellow text-brand-navy hover:bg-accent-yellow" : "")}
            aria-busy={busy}
          >
            {busy ? "Saving…" : "Submit"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
