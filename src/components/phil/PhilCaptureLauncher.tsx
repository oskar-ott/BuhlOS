"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  MapPin,
  Tag,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilDictateButton } from "./ui/PhilDictateButton";
import { PhilNotice } from "./ui/PhilNotice";
import { useOnline } from "./useOnline";
import { listJobs, getJobDetail } from "@/domains/jobs/client";
import { createEvidence, uploadEvidencePhoto } from "@/domains/evidence/client";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import { resizeImageWithMeta } from "@/domains/evidence/service";
import { submitCaptureBatch } from "@/domains/evidence/capture-batch";
import { effectiveTasks, stageLabel, visibleAreaGroups } from "@/domains/jobs/format";
import type { Job, JobStage } from "@/domains/jobs/types";
import { CapturePhotoTray, type TrayPhoto } from "./CapturePhotoTray";
import { CaptureTargetPickers } from "./CaptureTargetPickers";
import { PhilCaptureSharpened } from "./PhilCaptureSharpened";
import { usePhilSharpened } from "./philSharpenedContext";
import { shouldResetCompositionOnOpen, type CapturePurposeKey } from "./captureSharpened";
import { useSheetHistory } from "./useSheetHistory";
import {
  preselectCaptureJob,
  launcherDecision,
  type LaunchableJob,
} from "./philCapture";
import { cn } from "@/lib/cn";

/** A photo handed in from the global camera input (PhilTabBar). `seq` makes
 *  each hand-off unique so the consuming effect never double-adds. */
export interface IncomingCapturePhoto {
  file: File;
  seq: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** When the FAB is tapped on a job home we already know the job — it is
   *  preselected as the destination (still changeable). */
  initialJobId?: string | null;
  /** Latest photo from the global camera input. */
  incoming?: IncomingCapturePhoto | null;
  /** Re-fires the global camera input. Must be invoked from a direct tap so
   *  the browser treats it as a user gesture (iOS requirement). */
  onRequestCamera?: () => void;
}

type JobsState =
  | { v: "loading" }
  | { v: "error"; message: string }
  | { v: "ready"; jobs: LaunchableJob[] };

type SubmitState =
  | { v: "idle" }
  | { v: "submitting"; current: number; total: number }
  | { v: "done"; saved: number; jobName: string }
  | { v: "partial"; saved: number; failed: number };

type JobDetailState =
  | { v: "idle" }
  | { v: "loading" }
  | { v: "ready"; job: Job }
  | { v: "failed" };

const MAX_PHOTOS = 10;

/**
 * Global Capture launcher — opened by the centre FAB in PhilTabBar.
 *
 * v2 — CAMERA-FIRST: the FAB fires the OS camera in the same tap; this sheet
 * opens behind it and receives the shot. The worker keeps shooting (multi-photo
 * tray, up to 10), THEN decides where the batch goes: one of their jobs, with
 * an optional note and optional area/stage/task context. Each photo is saved
 * through the existing two-step evidence path (see capture-batch.ts) —
 * sequentially, with honest per-photo results: failures stay in the tray for
 * retry, successes leave it, and "saved" is only ever shown for confirmed rows.
 *
 * The pre-v2 launcher deep-linked to the job page's CaptureSheet
 * (`?capture=<token>`, see philCapture.captureHref); that link is no longer
 * generated here, but the job page still honours it and its own "Capture
 * evidence" CTA keeps using the in-context sheet.
 */
export function PhilCaptureLauncher({
  open,
  onClose,
  initialJobId,
  incoming,
  onRequestCamera,
}: Props) {
  const [jobsState, setJobsState] = useState<JobsState>({ v: "loading" });
  const [photos, setPhotos] = useState<TrayPhoto[]>([]);
  const [photoHint, setPhotoHint] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<JobDetailState>({ v: "idle" });
  const [stage, setStage] = useState<JobStage | null>(null);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ v: "idle" });

  // Sharpened re-skin (phil_sharpened, dark) — resolved server-side, carried
  // via PhilShell's context (this launcher is mounted by PhilTabBar, which
  // doesn't own its design). False (or no provider) = the current sheet,
  // byte-identical. The purpose chip lives HERE, like `note`, so an
  // accidental close keeps a half-typed composition (P8).
  const sharpened = usePhilSharpened();
  const [purpose, setPurpose] = useState<CapturePurposeKey>("progress");

  // Guards: stale job fetches + already-consumed camera hand-offs.
  const reqRef = useRef(0);
  const consumedSeqRef = useRef(0);
  const photoIdRef = useRef(0);
  const submitSignalRef = useRef(0);
  // Dictation (#147): mic appends to the batch note; offline disables it.
  const online = useOnline();
  const batchNoteRef = useRef<HTMLTextAreaElement | null>(null);

  // Back-safety (#149) — THE data-loss case: the photo tray lives in useState
  // and deliberately survives a close, so an accidental swipe-back / Android
  // back must CLOSE this sheet (keeping the tray) rather than navigate away and
  // strand the shots. closeWithHistory wraps every programmatic close (backdrop,
  // Close button, Esc, the success "Done" buttons) so the pushed entry unwinds
  // exactly once; the tray is never cleared on close.
  const { closeWithHistory } = useSheetHistory({ open, onClose });

  const submitting = submit.v === "submitting";

  const loadJobs = useCallback(async () => {
    reqRef.current += 1;
    const seq = reqRef.current;
    setJobsState({ v: "loading" });
    const r = await listJobs();
    if (seq !== reqRef.current) return;
    if (!r.ok) {
      setJobsState({
        v: "error",
        message:
          r.error.status === 0
            ? "No connection. Check your signal and try again."
            : `Couldn't load your jobs (${r.error.status}). Try again.`,
      });
      return;
    }
    const decision = launcherDecision(r.data.jobs);
    setJobsState({
      v: "ready",
      jobs:
        decision.kind === "empty"
          ? []
          : decision.kind === "single"
            ? [decision.job]
            : decision.jobs,
    });
  }, []);

  // Load jobs whenever the sheet opens; reset transient submit state. The
  // photo tray deliberately SURVIVES a close+reopen — an accidental backdrop
  // tap must not throw away a worker's shots.
  useEffect(() => {
    if (!open) return;
    setSubmit((s) => (s.v === "submitting" ? s : { v: "idle" }));
    void loadJobs();
  }, [open, loadJobs]);

  // Consume a photo handed in from the global camera input.
  useEffect(() => {
    if (!incoming || incoming.seq === consumedSeqRef.current) return;
    consumedSeqRef.current = incoming.seq;
    const file = incoming.file;
    if (!file.type.startsWith("image/")) {
      setPhotoHint("That isn't an image. Use the camera or pick a photo.");
      return;
    }
    setPhotoHint(null);
    setPhotos((prev) => {
      if (prev.length >= MAX_PHOTOS) {
        setPhotoHint(`Up to ${MAX_PHOTOS} photos per capture — save these first.`);
        return prev;
      }
      photoIdRef.current += 1;
      const id = `tp_${photoIdRef.current}`;
      void (async () => {
        try {
          // resizeImageWithMeta gives us the upload dataUrl AND a luminance
          // reading in the same downscale pass — the avgLuma drives the
          // non-blocking low-light tray hint (luma.ts) and never gates the save.
          const { dataUrl, avgLuma } = await resizeImageWithMeta(file, 1920, 0.7);
          setPhotos((cur) =>
            cur.map((p) =>
              p.id === id
                ? { ...p, dataUrl, status: "ready" as const, avgLuma: avgLuma ?? undefined }
                : p,
            ),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Couldn't read this photo.";
          setPhotos((cur) =>
            cur.map((p) => (p.id === id ? { ...p, status: "failed" as const, error: msg } : p)),
          );
        }
      })();
      return [...prev, { id, file, dataUrl: null, status: "resizing" }];
    });
  }, [incoming]);

  // Preselect the destination once jobs land: the job home the FAB was tapped
  // on, else the worker's only job. Never guesses between multiple jobs.
  useEffect(() => {
    if (jobsState.v !== "ready") return;
    setSelectedJobId((prev) => prev ?? preselectCaptureJob(jobsState.jobs, initialJobId ?? null));
  }, [jobsState, initialJobId]);

  // The kept composition (purpose) belongs to the job it was written against
  // — selectedJobId, which survives close by design (P8). Opening with a
  // DIFFERENT explicit job context (the FAB on another job's home) must not
  // reopen a composed Job-A capture while the worker stands on Job B: reset
  // the composition and let the explicit context win the selection (the
  // preselect above never overrides a stale prev). Same-job reopen and
  // no-context opens (My Day FAB) keep everything. Runs once per open, after
  // jobs land, so the incoming id is validated as a REAL job.
  const openReconciledRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openReconciledRef.current = false;
      return;
    }
    if (openReconciledRef.current || jobsState.v !== "ready") return;
    openReconciledRef.current = true;
    const incoming = initialJobId ?? null;
    if (incoming && shouldResetCompositionOnOpen(incoming, selectedJobId, jobsState.jobs)) {
      setPurpose("progress");
      setSelectedJobId(incoming);
    }
  }, [open, jobsState, initialJobId, selectedJobId]);

  // Fetch the selected job's detail (area groups) so the optional context
  // pickers are real. Fails soft — context stays unavailable, capture works.
  useEffect(() => {
    if (!selectedJobId) {
      setJobDetail({ v: "idle" });
      return;
    }
    let cancelled = false;
    setJobDetail({ v: "loading" });
    setStage(null);
    setAreaId(null);
    setTaskId(null);
    void getJobDetail(selectedJobId).then((r) => {
      if (cancelled) return;
      setJobDetail(r.ok ? { v: "ready", job: r.data.job } : { v: "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedJobId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeWithHistory();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeWithHistory]);

  const readyPhotos = photos.filter((p) => p.status === "ready" && p.dataUrl);
  const resizing = photos.some((p) => p.status === "resizing");
  const jobs = jobsState.v === "ready" ? jobsState.jobs : [];
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;

  const detailJob = jobDetail.v === "ready" ? jobDetail.job : null;
  const flatAreas = useMemo(
    () =>
      detailJob
        ? visibleAreaGroups(detailJob.areaGroups).flatMap((g) =>
            (g.areas ?? []).map((a) => ({ id: a.id, name: a.name, groupName: g.name })),
          )
        : [],
    [detailJob],
  );
  const selectedAreaName = areaId ? flatAreas.find((a) => a.id === areaId)?.name ?? null : null;
  const selectedTaskName = useMemo(() => {
    if (!detailJob || !taskId || !areaId || !stage) return null;
    const area =
      (detailJob.areaGroups ?? []).flatMap((g) => g.areas ?? []).find((a) => a.id === areaId) ??
      null;
    if (!area) return null;
    return effectiveTasks(detailJob, area, stage).find((t) => t.id === taskId)?.name ?? null;
  }, [detailJob, taskId, areaId, stage]);
  const contextParts = [stage ? stageLabel(stage) : null, selectedAreaName, selectedTaskName].filter(
    (p): p is string => Boolean(p),
  );

  const canSubmitBatch =
    !submitting &&
    !resizing &&
    readyPhotos.length > 0 &&
    !!selectedJob &&
    note.length <= EVIDENCE_NOTE_MAX &&
    (!taskId || (!!stage && !!areaId));

  const handleSubmitBatch = useCallback(async () => {
    if (!canSubmitBatch || !selectedJob) return;
    submitSignalRef.current += 1;
    const mySignal = submitSignalRef.current;
    const batch = readyPhotos.map((p) => ({ id: p.id, dataUrl: p.dataUrl! }));
    setSubmit({ v: "submitting", current: 1, total: batch.length });

    const result = await submitCaptureBatch(
      batch,
      {
        jobId: selectedJob.id,
        note,
        stage,
        areaId,
        taskId,
        clientCapturedAt: new Date().toISOString(),
      },
      { uploadPhoto: uploadEvidencePhoto, createEvidence },
      (p) => {
        if (mySignal === submitSignalRef.current) {
          setSubmit({ v: "submitting", current: p.current, total: p.total });
        }
      },
    );
    if (mySignal !== submitSignalRef.current) return;

    if (result.allSaved) {
      setPhotos([]);
      setNote("");
      setStage(null);
      setAreaId(null);
      setTaskId(null);
      setContextOpen(false);
      setSubmit({ v: "done", saved: result.savedCount, jobName: selectedJob.name });
      return;
    }
    // Failures stay in the tray with their honest message; successes leave it.
    const failedById = new Map<string, string>();
    for (const r of result.results) {
      if (!r.ok) failedById.set(r.id, r.message);
    }
    setPhotos((cur) =>
      cur
        .filter((p) => failedById.has(p.id) || p.status !== "ready")
        .map((p) =>
          failedById.has(p.id)
            ? { ...p, status: "failed" as const, error: failedById.get(p.id) }
            : p,
        ),
    );
    setSubmit({ v: "partial", saved: result.savedCount, failed: result.failedIds.length });
  }, [canSubmitBatch, selectedJob, readyPhotos, note, stage, areaId, taskId]);

  const retryFailed = useCallback(() => {
    // Failed photos return to "ready" (their dataUrl is still good) so the
    // submit loop can run them again. Resize failures have no dataUrl and
    // stay failed — the worker removes those.
    setPhotos((cur) =>
      cur.map((p) =>
        p.status === "failed" && p.dataUrl
          ? { ...p, status: "ready" as const, error: undefined }
          : p,
      ),
    );
    setSubmit({ v: "idle" });
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Capture"
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40"
      onClick={closeWithHistory}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-card border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Camera aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            <h2 className="font-display text-lg text-text">Capture</h2>
          </div>
          <button
            type="button"
            onClick={closeWithHistory}
            aria-label="Close"
            className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {submit.v === "done" ? (
            /* ── Batch saved ───────────────────────────────────────────── */
            <div className="space-y-4 py-4 text-center">
              <CheckCircle2 aria-hidden="true" className="mx-auto h-12 w-12 text-state-success" />
              <div>
                <p className="font-display text-lg text-text">
                  {submit.saved === 1 ? "Photo saved" : `${submit.saved} photos saved`}
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  Saved to <span className="font-semibold text-text">{submit.jobName}</span>. The
                  office can see them on the job now.
                </p>
              </div>
              <Button
                type="button"
                variant="primary"
                size="lg"
                className="w-full"
                onClick={() => {
                  setSubmit({ v: "idle" });
                  closeWithHistory();
                }}
              >
                Done
              </Button>
            </div>
          ) : sharpened ? (
            /* ── Sharpened capture (§2.5, phil_sharpened) — same mechanics,
                  re-skinned. ── */
            <PhilCaptureSharpened
              photos={photos}
              setPhotos={setPhotos}
              photoHint={photoHint}
              maxPhotos={MAX_PHOTOS}
              onRequestCamera={onRequestCamera}
              jobsLoading={jobsState.v === "loading"}
              jobsError={jobsState.v === "error" ? jobsState.message : null}
              onRetryJobs={() => void loadJobs()}
              jobs={jobs}
              selectedJobId={selectedJobId}
              onSelectJob={setSelectedJobId}
              fromJobContext={Boolean(initialJobId && selectedJobId === initialJobId)}
              detailJob={detailJob}
              jobDetailState={jobDetail.v}
              flatAreas={flatAreas}
              stage={stage}
              areaId={areaId}
              taskId={taskId}
              onStageChange={setStage}
              onAreaChange={setAreaId}
              onTaskChange={setTaskId}
              note={note}
              onNoteChange={setNote}
              purpose={purpose}
              onPurposeChange={setPurpose}
              online={online}
              onClose={closeWithHistory}
            />
          ) : (
            /* ── Camera-first capture ───────────────────────────────────── */
            <div className="space-y-5">
              <CapturePhotoTray
                photos={photos}
                max={MAX_PHOTOS}
                busy={submitting}
                onAdd={() => onRequestCamera?.()}
                onRemove={(id) => setPhotos((cur) => cur.filter((p) => p.id !== id))}
              />
              {photoHint ? (
                <p className="text-xs text-state-danger" role="alert">
                  {photoHint}
                </p>
              ) : null}

              {submit.v === "partial" ? (
                <PhilNotice tone="danger" role="alert" title="Some photos didn't save">
                  <p>
                    {submit.saved} saved · {submit.failed} failed — the failed ones are still here.
                  </p>
                  <div className="mt-2">
                    <Button type="button" variant="secondary" size="sm" onClick={retryFailed}>
                      Retry failed photos
                    </Button>
                  </div>
                </PhilNotice>
              ) : null}

              {photos.length > 0 ? (
                <>
                  {/* Destination */}
                  <div>
                    <p className="font-display text-sm font-semibold text-text">
                      Where does this go?
                    </p>
                    {jobsState.v === "loading" ? (
                      <p className="mt-2 flex items-center gap-2 text-sm text-text-muted">
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                        Loading your jobs…
                      </p>
                    ) : null}
                    {jobsState.v === "error" ? (
                      <div className="mt-2 space-y-2">
                        <PhilNotice tone="warning" role="alert">
                          {jobsState.message}
                        </PhilNotice>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void loadJobs()}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : null}
                    {jobsState.v === "ready" && jobs.length === 0 ? (
                      <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">
                        No jobs assigned to you yet. Ask your PM to add you to a job, then you can
                        capture against it.
                      </p>
                    ) : null}
                    {jobsState.v === "ready" && jobs.length > 0 ? (
                      <ul
                        className="mt-2 space-y-2"
                        role="radiogroup"
                        aria-label="Choose the job these photos are for"
                      >
                        {jobs.map((j) => {
                          const active = j.id === selectedJobId;
                          return (
                            <li key={j.id}>
                              <button
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={submitting}
                                onClick={() => setSelectedJobId(j.id)}
                                className={cn(
                                  "flex w-full items-center gap-3 rounded-card border p-3 text-left",
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
                                        "mt-0.5 flex items-center gap-1 text-xs",
                                        active ? "text-text-inverse/80" : "text-text-muted",
                                      )}
                                    >
                                      <MapPin
                                        aria-hidden="true"
                                        className="h-3.5 w-3.5 shrink-0"
                                      />
                                      <span className="truncate">{j.siteAddress}</span>
                                    </span>
                                  ) : null}
                                </span>
                                {active ? (
                                  <Check
                                    aria-hidden="true"
                                    className="h-5 w-5 shrink-0 text-accent-yellow"
                                  />
                                ) : (
                                  <ChevronRight
                                    aria-hidden="true"
                                    className="h-5 w-5 shrink-0 text-text-muted"
                                  />
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}

                  </div>

                  {/* Note */}
                  <div>
                    <label
                      htmlFor="capture-batch-note"
                      className="font-display text-sm font-semibold text-text"
                    >
                      Note <span className="font-normal text-text-muted">(optional)</span>
                    </label>
                    <textarea
                      id="capture-batch-note"
                      ref={batchNoteRef}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      disabled={submitting}
                      rows={2}
                      maxLength={EVIDENCE_NOTE_MAX}
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
                        onAppend={(next) => setNote(next)}
                        max={EVIDENCE_NOTE_MAX}
                        online={online}
                        disabled={submitting}
                        onFocusField={() => batchNoteRef.current?.focus()}
                      />
                    </div>
                  </div>

                  {/* Optional area/stage context — appears once a job is chosen. */}
                  {selectedJob && jobDetail.v !== "idle" ? (
                    <div>
                      <button
                        type="button"
                        onClick={() => setContextOpen((v) => !v)}
                        disabled={submitting || jobDetail.v !== "ready"}
                        aria-expanded={contextOpen}
                        aria-controls="capture-batch-context"
                        className={cn(
                          "flex min-h-[48px] w-full items-center gap-3 rounded-card border border-border bg-surface px-3 py-2 text-left",
                          "transition-colors hover:bg-surface-subtle",
                          "disabled:cursor-not-allowed disabled:opacity-60",
                        )}
                      >
                        <Tag aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                        <span className="min-w-0 flex-1">
                          {contextParts.length > 0 ? (
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
                                {jobDetail.v === "loading"
                                  ? "Loading the job's areas…"
                                  : jobDetail.v === "failed"
                                    ? "Areas unavailable right now — a photo on the job is enough."
                                    : "Skip it — a photo on the job is enough."}
                              </span>
                            </>
                          )}
                        </span>
                        {contextOpen ? (
                          <ChevronUp
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0 text-text-muted"
                          />
                        ) : (
                          <ChevronDown
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0 text-text-muted"
                          />
                        )}
                      </button>
                      {contextOpen && detailJob ? (
                        <div id="capture-batch-context" className="mt-3">
                          <CaptureTargetPickers
                            job={detailJob}
                            flatAreas={flatAreas}
                            stage={stage}
                            areaId={areaId}
                            taskId={taskId}
                            busy={submitting}
                            onStageChange={(s) => {
                              setStage(s);
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
                  ) : null}

                  <PhilActionButton
                    size="lg"
                    onClick={() => void handleSubmitBatch()}
                    disabled={!canSubmitBatch}
                    aria-busy={submitting}
                  >
                    {submit.v === "submitting"
                      ? `Saving photo ${submit.current} of ${submit.total}…`
                      : readyPhotos.length > 1
                        ? `Save ${readyPhotos.length} photos`
                        : "Save photo"}
                  </PhilActionButton>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
