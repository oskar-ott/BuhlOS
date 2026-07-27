"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Camera, Check, ChevronRight, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilDictateButton } from "./ui/PhilDictateButton";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilSyncBanner } from "./ui/PhilSyncBanner";
import { CapturePhotoTray, type TrayPhoto } from "./CapturePhotoTray";
import { CaptureTargetPickers } from "./CaptureTargetPickers";
import { submitCaptureBatch } from "@/domains/evidence/capture-batch";
import { createEvidence, uploadEvidencePhoto } from "@/domains/evidence/client";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { LaunchableJob } from "./philCapture";
import {
  applyBatchResultToTray,
  CAPTURE_PURPOSES,
  noteForPurpose,
  partialBatchFailureMessage,
  purposeByKey,
  sendableTrayBatch,
  type CapturePurposeKey,
} from "./captureSharpened";
import { cn } from "@/lib/cn";

/**
 * The SHARPENED Capture body (§2.5, dark behind phil_sharpened) — rendered by
 * PhilCaptureLauncher in place of its camera-first body when the flag is on.
 * Flag off ⇒ this file never renders; the launcher is byte-identical.
 *
 * Same REAL mechanics, re-skinned:
 *   - the OS camera stays the shutter (onRequestCamera fires the launcher's
 *     global camera input — a direct-tap requirement on iOS); the "viewfinder"
 *     is an honest preview of the latest shot, never a fake live feed.
 *   - "{n} in batch" is the real tray count (multi-shot up to the launcher's
 *     cap); the tray below keeps remove / per-photo errors / low-light hints.
 *   - saves go through the SAME two-step evidence path (capture-batch.ts) —
 *     sequential, per-photo honesty, failures stay in the tray.
 *   - sync states use PhilSyncBanner. There is NO offline outbox, so an
 *     offline/failed write shows the FAILED banner (nothing's lost — inputs
 *     and photos stay) — never the "sends itself" offline variant (P7).
 *
 * Constitution: P7 (no fake states; chips map to real concepts or are
 * omitted), P8 (inputs survive failure; non-optimistic writes), P10 (one
 * primary action; the purpose row replaces nothing), P11 (site voice).
 */

interface FlatArea {
  id: string;
  name: string;
  groupName: string;
}

export interface PhilCaptureSharpenedProps {
  photos: TrayPhoto[];
  setPhotos: Dispatch<SetStateAction<TrayPhoto[]>>;
  photoHint: string | null;
  maxPhotos: number;
  onRequestCamera?: () => void;

  jobsLoading: boolean;
  jobsError: string | null;
  onRetryJobs: () => void;
  jobs: LaunchableJob[];
  selectedJobId: string | null;
  onSelectJob: (id: string) => void;
  /** True only when the launcher was opened from this job's own screen — the
   *  one honest "Phil knows where you are" (context, not geolocation). */
  fromJobContext: boolean;

  detailJob: Job | null;
  jobDetailState: "idle" | "loading" | "ready" | "failed";
  flatAreas: FlatArea[];
  stage: JobStage | null;
  areaId: string | null;
  taskId: string | null;
  onStageChange: (next: JobStage | null) => void;
  onAreaChange: (next: string | null) => void;
  onTaskChange: (next: string | null) => void;

  /* Text state lives in the launcher so an accidental close keeps it (P8). */
  note: string;
  onNoteChange: (v: string) => void;
  purpose: CapturePurposeKey;
  onPurposeChange: (p: CapturePurposeKey) => void;

  online: boolean;

  /** closeWithHistory from the launcher. */
  onClose: () => void;
}

type SharpSubmit =
  | { v: "idle" }
  | { v: "sending"; detail: string }
  | { v: "failed"; message: string }
  | {
      v: "saved";
      savedPhotos: number;
      jobName: string;
      areaName: string | null;
      purposeLabel: string;
    };

export function PhilCaptureSharpened({
  photos,
  setPhotos,
  photoHint,
  maxPhotos,
  onRequestCamera,
  jobsLoading,
  jobsError,
  onRetryJobs,
  jobs,
  selectedJobId,
  onSelectJob,
  fromJobContext,
  detailJob,
  jobDetailState,
  flatAreas,
  stage,
  areaId,
  taskId,
  onStageChange,
  onAreaChange,
  onTaskChange,
  note,
  onNoteChange,
  purpose,
  onPurposeChange,
  online,
  onClose,
}: PhilCaptureSharpenedProps) {
  const [submit, setSubmit] = useState<SharpSubmit>({ v: "idle" });
  const [changingJob, setChangingJob] = useState(false);

  // Cross-retry memory so a resumed submit never double-writes what already
  // landed: photos saved as evidence keep their ids.
  const savedEvidenceIdsRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const safeSetSubmit = useCallback((s: SharpSubmit) => {
    if (mountedRef.current) setSubmit(s);
  }, []);

  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const areaName = areaId ? (flatAreas.find((a) => a.id === areaId)?.name ?? null) : null;
  const readyPhotos = photos.filter((p) => p.status === "ready" && p.dataUrl);
  // The batch a save/retry actually sends: ready photos AND retryable
  // failures (bytes still good) — a failed photo is never silently dropped.
  const sendable = sendableTrayBatch(photos);
  const resizing = photos.some((p) => p.status === "resizing");
  const latestPreview = [...readyPhotos].reverse()[0] ?? null;
  const busy = submit.v === "sending";

  // A fresh purpose = a fresh write chain. Clears the cross-retry memory.
  const switchPurpose = useCallback(
    (p: CapturePurposeKey) => {
      onPurposeChange(p);
      savedEvidenceIdsRef.current = [];
      setSubmit((s) => (s.v === "failed" ? { v: "idle" } : s));
    },
    [onPurposeChange],
  );

  const canSave =
    !busy &&
    !resizing &&
    !!selectedJob &&
    // Failed-but-retryable counts as actionable — the Retry path must never
    // be dead after a partial batch failure. And if the worker REMOVES the
    // failed photos instead, the save can still complete on the strength of
    // what already landed (savedEvidenceIdsRef) — those photos are filed and
    // deserve their receipt. (Reading the ref at render is safe: every push
    // is followed by a submit-state render.)
    (sendable.length > 0 || savedEvidenceIdsRef.current.length > 0) &&
    note.length <= EVIDENCE_NOTE_MAX;

  /** Save the tray through the existing two-step evidence path. Returns true
   *  when every photo landed; failures stay in the tray with their message.
   *  The batch is `sendable` — ready photos plus retryable failures — so a
   *  retry re-sends ONLY what failed (saved photos already left the tray and
   *  keep their ids in savedEvidenceIdsRef; never re-uploaded). */
  const saveBatch = useCallback(
    async (caption: string): Promise<boolean> => {
      if (!selectedJob) return false;
      const batch = sendableTrayBatch(photos);
      // Empty = genuinely no photos in play — never "the failures got
      // excluded": failed-with-bytes photos are IN the batch.
      if (batch.length === 0) return true;
      safeSetSubmit({
        v: "sending",
        detail:
          batch.length === 1 ? "One photo on the way up." : `Photo 1 of ${batch.length} on the way up.`,
      });
      const result = await submitCaptureBatch(
        batch,
        {
          jobId: selectedJob.id,
          note: caption,
          stage,
          areaId,
          taskId,
          clientCapturedAt: new Date().toISOString(),
        },
        { uploadPhoto: uploadEvidencePhoto, createEvidence },
        (p) =>
          safeSetSubmit({
            v: "sending",
            detail: `Photo ${p.current} of ${p.total} on the way up.`,
          }),
      );
      for (const r of result.results) {
        if (r.ok) savedEvidenceIdsRef.current.push(r.evidence.id);
      }
      if (mountedRef.current) {
        // Saved photos leave the tray; failures stay with their message.
        setPhotos((cur) => applyBatchResultToTray(cur, result.results));
      }
      if (!result.allSaved) {
        // The honest split (P7): already-saved ids are claimed as up; failed
        // ones are still here.
        safeSetSubmit({
          v: "failed",
          message: partialBatchFailureMessage(
            savedEvidenceIdsRef.current.length,
            result.failedIds.length,
          ),
        });
        return false;
      }
      return true;
    },
    [selectedJob, photos, stage, areaId, taskId, setPhotos, safeSetSubmit],
  );

  const handleSave = useCallback(async () => {
    if (!canSave || !selectedJob) return;

    const ok = await saveBatch(noteForPurpose(purpose, note));
    if (!ok) return;
    safeSetSubmit({
      v: "saved",
      savedPhotos: savedEvidenceIdsRef.current.length,
      jobName: selectedJob.name,
      areaName,
      purposeLabel: purposeByKey(purpose).label,
    });
    savedEvidenceIdsRef.current = [];
    onNoteChange("");
  }, [
    canSave,
    selectedJob,
    purpose,
    note,
    areaName,
    saveBatch,
    safeSetSubmit,
    onNoteChange,
  ]);

  /** Retry after a failure — the launcher's proven `retryFailed` semantics:
   *  failed photos (their bytes are still good) flip back to ready and ONLY
   *  they go up again — saved photos already left the tray and keep their
   *  evidence ids in savedEvidenceIdsRef, so nothing is ever re-uploaded (no
   *  duplicate evidence). The save chain then resumes where it stopped.
   *  (handleSave reads the same sendable set, so the flip is honest tray UI,
   *  not a data dependency.) */
  const retryFailed = useCallback(() => {
    setPhotos((cur) =>
      cur.map((p) =>
        p.status === "failed" && p.dataUrl
          ? { ...p, status: "ready" as const, error: undefined }
          : p,
      ),
    );
    void handleSave();
  }, [setPhotos, handleSave]);

  const captureAnother = useCallback(() => {
    setSubmit({ v: "idle" });
    // Direct tap → the launcher's global camera input is allowed to fire.
    onRequestCamera?.();
  }, [onRequestCamera]);

  /* ── Receipts ─────────────────────────────────────────────────────────── */
  if (submit.v === "saved") {
    const photosLine =
      submit.savedPhotos > 0
        ? `${submit.savedPhotos === 1 ? "1 photo" : `${submit.savedPhotos} photos`} filed to ${[
            submit.jobName,
            submit.areaName,
            submit.purposeLabel,
          ]
            .filter(Boolean)
            .join(" · ")}.`
        : null;
    return (
      <div className="space-y-4" data-testid="phil-capture-sharpened-saved">
        <PhilSyncBanner state="saved" detail={photosLine ?? undefined} />
        <PhilActionButton size="lg" onClick={captureAnother}>
          Capture another
        </PhilActionButton>
        <Button type="button" variant="secondary" size="lg" className="w-full" onClick={onClose}>
          {fromJobContext ? "Back to the job" : "Done"}
        </Button>
      </div>
    );
  }

  /* ── The capture form ─────────────────────────────────────────────────── */
  return (
    <div className="space-y-5" data-testid="phil-capture-sharpened">
      {/* Viewfinder — an honest preview of the latest shot (the OS camera is
          the real viewfinder; the shutter re-fires it in the same tap). */}
      <div>
        <div className="relative overflow-hidden rounded-card border border-border bg-brand-navy">
          <div className="flex aspect-[4/3] items-center justify-center">
            {latestPreview?.dataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- dataURL preview, not optimised
              <img
                src={latestPreview.dataUrl}
                alt="Latest shot"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="px-6 text-center">
                <Camera aria-hidden="true" className="mx-auto h-8 w-8 text-white/70" />
                <p className="mt-2 text-sm font-semibold text-white">
                  Tap the shutter to shoot
                </p>
                <p className="mt-1 text-[12px] text-white/70">
                  The camera opens — every shot lands in the batch below.
                </p>
              </div>
            )}
          </div>
          {photos.length > 0 ? (
            <span
              data-testid="capture-batch-count"
              className="absolute right-2 top-2 rounded-pill border border-border bg-surface px-2.5 py-1 font-display text-[12px] font-bold text-text"
            >
              {`${photos.length} in batch`}
            </span>
          ) : null}
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <button
              type="button"
              data-testid="capture-shutter"
              aria-label="Take a photo"
              disabled={busy || photos.length >= maxPhotos}
              onClick={() => onRequestCamera?.()}
              className={cn(
                "h-16 w-16 rounded-full border-4 border-white/40 bg-accent-yellow shadow-raised",
                "transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-60",
              )}
            />
          </div>
        </div>
        <p className="mt-2 text-[12px] text-text-muted">
          Shots wait here — nothing sends until you save.
        </p>
      </div>

      {photoHint ? (
        <p className="text-[12px] text-state-danger" role="alert">
          {photoHint}
        </p>
      ) : null}

      {photos.length > 0 ? (
        <CapturePhotoTray
          photos={photos}
          max={maxPhotos}
          busy={busy}
          onAdd={() => onRequestCamera?.()}
          onRemove={(id) => setPhotos((cur) => cur.filter((p) => p.id !== id))}
        />
      ) : null}

      {/* What's this for? — single-select; every chip maps to a real concept
          (philCaptureSharpened.ts documents the mapping + the omissions). */}
      <fieldset>
        <legend className="font-display text-sm font-semibold text-text">
          What&rsquo;s this for?
        </legend>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="What's this for?">
          {CAPTURE_PURPOSES.map((p) => {
            const active = p.key === purpose;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`capture-purpose-${p.key}`}
                disabled={busy}
                onClick={() => switchPurpose(p.key)}
                className={cn(
                  "min-h-[44px] rounded-pill border px-4 font-display text-sm font-semibold",
                  "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-brand-navy bg-brand-navy text-text-inverse"
                    : "border-border bg-surface text-text hover:bg-surface-subtle",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[12px] text-text-muted">{purposeByKey(purpose).hint}</p>
      </fieldset>

      {/* Note — the photo caption the office sees. */}
      <div>
        <label
          htmlFor="capture-sharpened-note"
          className="font-display text-sm font-semibold text-text"
        >
          Note <span className="font-normal text-text-muted">(optional)</span>
        </label>
        <textarea
          id="capture-sharpened-note"
          ref={noteRef}
          value={note}
          rows={2}
          maxLength={EVIDENCE_NOTE_MAX}
          disabled={busy}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="What do these photos show?"
          className={cn(
            "mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text",
            "placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <div className="mt-2">
          <PhilDictateButton
            value={note}
            onAppend={onNoteChange}
            max={EVIDENCE_NOTE_MAX}
            online={online}
            disabled={busy}
            onFocusField={() => noteRef.current?.focus()}
          />
        </div>
      </div>

      {/* Filed to — the locked job chip + the job's REAL areas. */}
      <div>
        <p className="font-display text-sm font-semibold text-text">Filed to</p>
        {jobsLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-text-muted">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Loading your jobs…
          </p>
        ) : null}
        {jobsError ? (
          <div className="mt-2 space-y-2">
            <PhilNotice tone="warning" role="alert">
              {jobsError}
            </PhilNotice>
            <Button type="button" variant="secondary" size="sm" onClick={onRetryJobs}>
              Try again
            </Button>
          </div>
        ) : null}
        {!jobsLoading && !jobsError && jobs.length === 0 ? (
          <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">
            No jobs assigned to you yet. Ask your PM to add you to a job, then you can capture
            against it.
          </p>
        ) : null}

        {selectedJob && !changingJob ? (
          <div className="mt-2">
            <div
              data-testid="capture-filed-job"
              className="flex items-center gap-3 rounded-card border border-brand-navy bg-brand-navy p-3 text-text-inverse"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-sm font-semibold">
                  {selectedJob.name}
                </span>
                {selectedJob.siteAddress ? (
                  <span className="mt-0.5 flex items-center gap-1 text-[12px] text-text-inverse/80">
                    <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{selectedJob.siteAddress}</span>
                  </span>
                ) : null}
              </span>
              {jobs.length > 1 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setChangingJob(true)}
                  className="min-h-[44px] shrink-0 rounded-card px-3 text-[12px] font-semibold uppercase tracking-wide text-accent-yellow"
                >
                  Change
                </button>
              ) : (
                <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-yellow" />
              )}
            </div>
            {fromJobContext ? (
              <p className="mt-1 text-[12px] text-text-muted">
                Phil knows where you are — you opened Capture from this job.
              </p>
            ) : null}
          </div>
        ) : null}

        {jobs.length > 0 && (changingJob || !selectedJob) ? (
          <ul className="mt-2 space-y-2" role="radiogroup" aria-label="Choose the job">
            {jobs.map((j) => {
              const active = j.id === selectedJobId;
              return (
                <li key={j.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy}
                    onClick={() => {
                      onSelectJob(j.id);
                      setChangingJob(false);
                    }}
                    className={cn(
                      "flex min-h-[48px] w-full items-center gap-3 rounded-card border p-3 text-left",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-brand-navy bg-brand-navy text-text-inverse"
                        : "border-border bg-surface text-text hover:bg-surface-subtle",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm font-semibold">
                        {j.name}
                      </span>
                      {j.siteAddress ? (
                        <span
                          className={cn(
                            "mt-0.5 flex items-center gap-1 text-[12px]",
                            active ? "text-text-inverse/80" : "text-text-muted",
                          )}
                        >
                          <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{j.siteAddress}</span>
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Areas / stage / task — the same pickers, same rules, shown inline. */}
        {selectedJob ? (
          <div className="mt-3">
            {jobDetailState === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-text-muted">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                Loading the job&rsquo;s areas…
              </p>
            ) : jobDetailState === "failed" ? (
              <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-[12px] text-text-muted">
                Areas unavailable right now — a photo on the job is enough.
              </p>
            ) : detailJob ? (
              <CaptureTargetPickers
                job={detailJob}
                flatAreas={flatAreas}
                stage={stage}
                areaId={areaId}
                taskId={taskId}
                busy={busy}
                onStageChange={(s) => {
                  onStageChange(s);
                  if (!s) onTaskChange(null);
                }}
                onAreaChange={(a) => {
                  onAreaChange(a);
                  if (!a) onTaskChange(null);
                }}
                onTaskChange={onTaskChange}
              />
            ) : null}
          </div>
        ) : null}

      </div>

      {submit.v === "sending" ? <PhilSyncBanner state="sending" detail={submit.detail} /> : null}
      {submit.v === "failed" ? (
        <PhilSyncBanner state="failed" detail={submit.message} onRetry={retryFailed} />
      ) : null}

      <PhilActionButton
        size="lg"
        onClick={() => void handleSave()}
        disabled={!canSave}
        aria-busy={busy}
        data-testid="capture-sharpened-save"
      >
        {busy ? "Sending…" : "Save & file to job"}
      </PhilActionButton>
    </div>
  );
}
