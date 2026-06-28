"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  createEvidence,
  uploadEvidencePhoto,
} from "@/domains/evidence/client";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import { resizeImageWithMeta } from "@/domains/evidence/service";
import { isLowLight } from "@/domains/evidence/luma";
import type {
  CreateEvidencePayload,
  EvidenceItem,
} from "@/domains/evidence/types";
import { effectiveTasks, stageLabel, visibleAreaGroups } from "@/domains/jobs/format";
import type { Job, JobStage } from "@/domains/jobs/types";
import { CapturePhotoPicker } from "./CapturePhotoPicker";
import { CaptureTargetPickers } from "./CaptureTargetPickers";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilDictateButton } from "./ui/PhilDictateButton";
import { PhilNotice } from "./ui/PhilNotice";
import { useOnline } from "./useOnline";
import { useSheetHistory } from "./useSheetHistory";
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
  /** #230: fired ONLY when the worker dismisses the sheet WITHOUT submitting
   *  (X / Cancel / Escape) — never on the close-on-submit path. Lets a caller
   *  that awaited a capture (the Services card) resolve its promise with "no
   *  photo". Additive + optional: existing callers are unaffected. */
  onCancel?: () => void;
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
  onCancel,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // Measured average luma off the downscaled photo (0–255), for the
  // non-blocking low-light review hint. Null = not measured / not dark.
  const [avgLuma, setAvgLuma] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [stage, setStage] = useState<JobStage | null>(initialContext?.stage ?? null);
  const [areaId, setAreaId] = useState<string | null>(initialContext?.areaId ?? null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [resizing, setResizing] = useState(false);
  // Context (stage / area / task) starts collapsed: the default sheet is photo
  // + optional note + one optional line, not a wall of pickers. The pickers are
  // one tap away and unchanged. Worker-first: take the photo now, add context
  // only if it helps.
  const [contextOpen, setContextOpen] = useState(false);

  // The sheet may unmount mid-flight (worker taps Cancel after Submit).
  // Track a per-submit signal so the async chain doesn't fire callbacks
  // for a stale submission.
  const submitSignalRef = useRef(0);

  // Dictation (#147): the mic appends recognised text to the note. Online state
  // gates it (the vendor speech service needs a connection); the field ref lets
  // the iOS keyboard-nudge path focus the textarea.
  const online = useOnline();
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  // Back-safety (#149): a swipe-back / Android back closes the sheet instead of
  // navigating off the job page. closeWithHistory wraps every programmatic close
  // (Close button / Esc / Cancel / close-on-submit) so it unwinds the pushed
  // history entry exactly once.
  const { closeWithHistory } = useSheetHistory({ open, onClose });

  // #230: dismiss WITHOUT submitting (X / Cancel / Escape). Fires onCancel so a
  // caller that awaited a capture (the Services card) learns "no photo", then
  // the existing history-aware close. The close-on-submit path stays on
  // closeWithHistory alone, so onCancel never fires for a real capture.
  const cancelWithHistory = useCallback(() => {
    onCancel?.();
    closeWithHistory();
  }, [onCancel, closeWithHistory]);

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
      if (e.key === "Escape") cancelWithHistory();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, cancelWithHistory]);

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

  // Plain-language summary of whatever context is attached — shown on the
  // collapsed row so nothing is hidden (the worker still sees a carried-in
  // stage/area), while the full picker list stays one tap away. Resolved from
  // the real job; never invented.
  const selectedAreaName = useMemo(
    () => (areaId ? flatAreas.find((a) => a.id === areaId)?.name ?? null : null),
    [areaId, flatAreas],
  );
  const selectedTaskName = useMemo(() => {
    if (!taskId || !areaId || !stage) return null;
    const area =
      (job.areaGroups ?? [])
        .flatMap((g) => g.areas ?? [])
        .find((a) => a.id === areaId) ?? null;
    if (!area) return null;
    return effectiveTasks(job, area, stage).find((t) => t.id === taskId)?.name ?? null;
  }, [job, taskId, areaId, stage]);
  const contextParts = [
    stage ? stageLabel(stage) : null,
    selectedAreaName,
    selectedTaskName,
  ].filter((p): p is string => Boolean(p));
  const hasContext = contextParts.length > 0;

  const handlePick = useCallback(async (next: File) => {
    setFile(next);
    setDataUrl(null);
    setAvgLuma(null);
    setResizing(true);
    try {
      // Same downscale pass also reads the luminance for the low-light hint.
      const { dataUrl: resized, avgLuma: luma } = await resizeImageWithMeta(next, 1920, 0.7);
      setDataUrl(resized);
      setAvgLuma(luma);
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
    // async chain resolves via onCaptured / onFailed. closeWithHistory unwinds
    // the back-safety entry so a later swipe doesn't pop a stale one (#149).
    closeWithHistory();

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
      setAvgLuma(null);
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
    closeWithHistory,
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
          onClick={cancelWithHistory}
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
            <PhilNotice tone="danger" role="alert">
              {phase.message}
            </PhilNotice>
          ) : null}

          <CapturePhotoPicker
            file={file}
            previewDataUrl={dataUrl}
            busy={busy}
            onPick={handlePick}
          />

          {/* Non-blocking low-light hint — additive review nudge (P10). It
              never disables Submit (canSubmit ignores luma) and reflects a real
              measured luminance (P7). Shown once the resize has a reading. */}
          {dataUrl && isLowLight(avgLuma) ? (
            <PhilNotice tone="warning" role="status" title="Bit dark — try the flash">
              This photo looks dark. It&rsquo;ll still save — retake with the flash on if you
              want the office to see more.
            </PhilNotice>
          ) : null}

          <div>
            <label htmlFor="capture-note" className="font-display text-sm font-semibold text-text">
              Note <span className="text-text-muted">(optional)</span>
            </label>
            <textarea
              id="capture-note"
              ref={noteRef}
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
            <div className="mt-2 flex items-start justify-between gap-3">
              <PhilDictateButton
                value={note}
                onAppend={(next) => setNote(next)}
                max={EVIDENCE_NOTE_MAX}
                online={online}
                disabled={busy}
                onFocusField={() => noteRef.current?.focus()}
                className="min-w-0"
              />
              <p className="mt-3 shrink-0 text-right text-xs text-text-muted">
                {noteLen} / {EVIDENCE_NOTE_MAX}
              </p>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              disabled={busy}
              aria-expanded={contextOpen}
              aria-controls="capture-context"
              className={cn(
                "flex min-h-[48px] w-full items-center gap-3 rounded-card border border-border bg-surface px-3 py-2 text-left",
                "transition-colors hover:bg-surface-subtle",
                "disabled:cursor-not-allowed disabled:opacity-60"
              )}
            >
              <Tag aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1">
                {hasContext ? (
                  <>
                    <span className="block truncate text-sm font-semibold text-text">
                      {contextParts.join(" · ")}
                    </span>
                    <span className="block text-xs text-text-muted">
                      Tap to change area, stage or task
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block text-sm font-semibold text-text">
                      Add area or stage{" "}
                      <span className="font-normal text-text-muted">(optional)</span>
                    </span>
                    <span className="block text-xs text-text-muted">
                      Skip it — a photo on the job is enough.
                    </span>
                  </>
                )}
              </span>
              {contextOpen ? (
                <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              ) : (
                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              )}
            </button>

            {contextOpen ? (
              <div id="capture-context" className="mt-3">
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
            ) : null}
          </div>
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
            onClick={cancelWithHistory}
            disabled={busy}
            className="flex-1"
          >
            Cancel
          </Button>
          <PhilActionButton
            size="lg"
            fullWidth={false}
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1"
            aria-busy={busy}
          >
            {busy ? "Saving…" : "Submit"}
          </PhilActionButton>
        </div>
      </footer>
    </div>
  );
}
