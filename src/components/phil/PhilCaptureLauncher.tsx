"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
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
import {
  createObservation,
  createOfficeObservation,
  uploadOfficePhoto,
} from "@/domains/observations/client";
import {
  OFFICE_CAPTURE_OPTIONS,
  WORKER_CAPTURE_OPTIONS,
  requiresActionForOption,
  type WorkerCaptureOption,
} from "@/domains/observations/service";
import { submitOfficeCapture } from "@/domains/observations/office-capture";
import { OBSERVATION_DESCRIPTION_MAX } from "@/domains/observations/schema";
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
import type { CapturePurposeKey } from "./captureSharpened";
import { useSheetHistory } from "./useSheetHistory";
import {
  buildObservationPayload,
  buildOfficeObservationPayload,
  preselectCaptureJob,
  launcherDecision,
  resolveQuickCapture,
  type CaptureQuickAction,
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
  /** When opened from a My Day quick-action tile, the launcher jumps straight
   *  to that action (office option, or a worker option on the single job) once
   *  it opens. Null/undefined for the FAB, which opens the normal flow. */
  initialAction?: CaptureQuickAction | null;
  /** Monotonic id of the current quick-action request (0 = none). A new value
   *  — a fresh tile tap, or a different tile while the sheet is already open —
   *  re-applies the preset, so switching tiles isn't swallowed. */
  actionSeq?: number;
}

type Job0 = { id: string; name: string | null };

type JobsState =
  | { v: "loading" }
  | { v: "error"; message: string }
  | { v: "ready"; jobs: LaunchableJob[] };

/** The no-photo "log something" flow — the pre-existing observation loop,
 *  unchanged: pick a job (when needed) → choose a label → note → done. */
type NoteFlow =
  | null
  | { step: "pick" }
  | { step: "options"; job: Job0 }
  | { step: "note"; job: Job0; option: WorkerCaptureOption }
  | { step: "done"; requiresAction: boolean };

type SubmitState =
  | { v: "idle" }
  | { v: "submitting"; current: number; total: number }
  | { v: "sending" }
  | { v: "done"; saved: number; jobName: string }
  | { v: "done_office"; photos: number }
  | { v: "partial"; saved: number; failed: number };

type JobDetailState =
  | { v: "idle" }
  | { v: "loading" }
  | { v: "ready"; job: Job }
  | { v: "failed" };

const MAX_PHOTOS = 10;
const TITLE_MAX = 140;

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
 * No-photo logging is preserved: with an empty tray the worker can still "log
 * something" (the unchanged observation loop → POST /api/observations).
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
  initialAction,
  actionSeq = 0,
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
  // "Send to office" destination (no job) — fines, damaged gear, paperwork.
  const [destOffice, setDestOffice] = useState(false);
  const [officeOptionKey, setOfficeOptionKey] = useState<string | null>(null);
  // Office sends are photo-first: a photo + an OPTIONAL note. The item is
  // auto-titled from the chosen option (e.g. "Fine / ticket / paperwork"), so
  // the worker never has to type a title to send.
  const [officeDetail, setOfficeDetail] = useState("");
  const [officeError, setOfficeError] = useState<string | null>(null);

  // Sharpened re-skin (phil_sharpened, dark) — resolved server-side, carried
  // via PhilShell's context (this launcher is mounted by PhilTabBar, which
  // doesn't own its design). False (or no provider) = the current sheet,
  // byte-identical. The purpose chip + branch text live HERE, like `note`,
  // so an accidental close keeps a half-typed question/snag title (P8).
  const sharpened = usePhilSharpened();
  const [purpose, setPurpose] = useState<CapturePurposeKey>("progress");
  const [rfiQuestion, setRfiQuestion] = useState("");
  const [snagTitle, setSnagTitle] = useState("");

  // No-photo observation loop state (pre-existing flow).
  const [noteFlow, setNoteFlow] = useState<NoteFlow>(null);
  // A worker quick-action option carried through the job picker (when the
  // worker has several jobs): once they pick a job we land straight on its
  // note step for this option instead of the generic option list.
  const [pendingWorkerOption, setPendingWorkerOption] = useState<WorkerCaptureOption | null>(null);
  const [obsTitle, setObsTitle] = useState("");
  const [obsDescription, setObsDescription] = useState("");
  const [obsSubmitting, setObsSubmitting] = useState(false);
  const [obsError, setObsError] = useState<string | null>(null);
  // #369 — structured variation flag fields (only the "variation" option uses them).
  const [obsAskedBy, setObsAskedBy] = useState("");
  const [obsLabourHours, setObsLabourHours] = useState("");
  const [obsMaterialsNote, setObsMaterialsNote] = useState("");

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

  const submitting = submit.v === "submitting" || submit.v === "sending";

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

  // Load jobs whenever the sheet opens; reset transient submit/observation
  // state. The photo tray deliberately SURVIVES a close+reopen — an accidental
  // backdrop tap must not throw away a worker's shots.
  useEffect(() => {
    if (!open) return;
    setObsTitle("");
    setObsDescription("");
    setObsAskedBy("");
    setObsLabourHours("");
    setObsMaterialsNote("");
    setObsError(null);
    setObsSubmitting(false);
    setNoteFlow(null);
    setOfficeError(null);
    // Clean slate for the destination each open so a prior tile's "send to
    // office" / carried worker option never leaks into a fresh FAB capture.
    setDestOffice(false);
    setOfficeOptionKey(null);
    setPendingWorkerOption(null);
    setSubmit((s) => (s.v === "submitting" || s.v === "sending" ? s : { v: "idle" }));
    void loadJobs();
  }, [open, loadJobs]);

  // Quick-action preset (My Day tiles): when the launcher is opened with an
  // initialAction, jump straight to it. Office options need no job and apply at
  // once; a worker option waits for jobs to land, then targets the sole job (or
  // carries the option through the picker for a multi-job worker). Keyed on the
  // request seq, so each new tap — including switching to a DIFFERENT tile while
  // the sheet is open — re-applies, and so the same seq never double-applies
  // (e.g. while jobs are still loading). The FAB passes seq 0, so its flow is
  // untouched. Each apply first clears the other destination, since the open
  // reset effect doesn't re-run when switching tiles within one open session.
  const appliedSeqRef = useRef(0);
  useEffect(() => {
    if (!open) {
      // Reset the preset lifecycle AND the destination while the sheet is
      // hidden (it renders null when closed), so the next open — the FAB or
      // another tile — starts clean with no one-frame flash of the prior
      // tile's office/note state on reopen. The photo tray survives by design.
      appliedSeqRef.current = 0;
      setDestOffice(false);
      setOfficeOptionKey(null);
      setOfficeDetail("");
      setNoteFlow(null);
      setPendingWorkerOption(null);
      return;
    }
    if (!initialAction || actionSeq === 0 || appliedSeqRef.current === actionSeq) return;
    if (initialAction.kind === "worker" && jobsState.v !== "ready") return; // await jobs
    const jobsList = jobsState.v === "ready" ? jobsState.jobs : [];
    const preset = resolveQuickCapture(initialAction, jobsList, initialJobId ?? null);
    appliedSeqRef.current = actionSeq;
    // Clean slate for the destination before applying, so switching tiles
    // mid-open never leaves the previous tile's office/note state behind.
    setDestOffice(false);
    setOfficeOptionKey(null);
    setNoteFlow(null);
    setPendingWorkerOption(null);
    switch (preset.mode) {
      case "office":
        setDestOffice(true);
        setOfficeOptionKey(preset.option.key);
        break;
      case "worker-note":
        setNoteFlow({
          step: "note",
          job: { id: preset.job.id, name: preset.job.name },
          option: preset.option,
        });
        break;
      case "worker-pick":
        setPendingWorkerOption(preset.option);
        setNoteFlow({ step: "pick" });
        break;
      case "none":
        break;
    }
  }, [open, initialAction, actionSeq, jobsState, initialJobId]);

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

  // ── "Send to office" (no job) ──────────────────────────────────────────
  const officeOption = officeOptionKey
    ? OFFICE_CAPTURE_OPTIONS.find((o) => o.key === officeOptionKey) ?? null
    : null;
  // Sendable for the office path: ready, already uploaded on a previous
  // attempt, or upload-failed but with a good dataUrl (retryable). Resize
  // failures (no dataUrl at all) are excluded — their tile shows why.
  const officePhotos = photos.filter(
    (p) => (p.status === "ready" && p.dataUrl) || p.officeUrl || (p.status === "failed" && p.dataUrl),
  );
  // Photo-first: a photo + a chosen option is enough to send. The note is
  // optional and the title is auto-derived from the option, so there is no
  // required typing.
  const canSubmitOffice = !submitting && !resizing && officePhotos.length > 0 && !!officeOption;

  const handleSubmitOffice = useCallback(async () => {
    if (!canSubmitOffice || !officeOption) return;
    submitSignalRef.current += 1;
    const mySignal = submitSignalRef.current;
    setOfficeError(null);
    const batch = officePhotos.map((p) => ({
      id: p.id,
      dataUrl: p.dataUrl ?? "",
      uploadedUrl: p.officeUrl ?? null,
    }));
    setSubmit({ v: "submitting", current: 1, total: batch.length });

    const result = await submitOfficeCapture(
      batch,
      buildOfficeObservationPayload(officeOption, officeOption.label, officeDetail),
      { uploadPhoto: uploadOfficePhoto, create: createOfficeObservation },
      (p) => {
        if (mySignal !== submitSignalRef.current) return;
        if (p.step === "uploading") {
          setSubmit({ v: "submitting", current: p.current, total: p.total });
        } else {
          setSubmit({ v: "sending" });
        }
      },
    );
    if (mySignal !== submitSignalRef.current) return;

    if (result.ok) {
      setPhotos([]);
      setOfficeDetail("");
      setOfficeOptionKey(null);
      setDestOffice(false);
      setSubmit({ v: "done_office", photos: batch.length });
      return;
    }
    // Nothing reached the office yet (the item is only created once every
    // photo is up). Keep successful uploads for the retry; mark failures.
    setPhotos((cur) =>
      cur.map((p) => {
        const uploaded = result.uploadedById[p.id];
        const failed = result.phase === "upload" && result.failedIds.includes(p.id);
        return {
          ...p,
          ...(uploaded ? { officeUrl: uploaded, status: "ready" as const, error: undefined } : {}),
          ...(failed
            ? { status: "failed" as const, error: "Upload failed — tap Send to retry" }
            : {}),
        };
      }),
    );
    setOfficeError(result.message);
    setSubmit({ v: "idle" });
  }, [canSubmitOffice, officeOption, officePhotos, officeDetail]);

  // ── No-photo observation loop (pre-existing behaviour) ────────────────
  const startNoteFlow = useCallback(() => {
    setObsTitle("");
    setObsDescription("");
    setObsAskedBy("");
    setObsLabourHours("");
    setObsMaterialsNote("");
    setObsError(null);
    if (jobsState.v !== "ready" || jobsState.jobs.length === 0) return;
    const preselected = preselectCaptureJob(jobsState.jobs, initialJobId ?? null);
    if (preselected) {
      const j = jobsState.jobs.find((x) => x.id === preselected)!;
      setNoteFlow({ step: "options", job: { id: j.id, name: j.name } });
    } else {
      setNoteFlow({ step: "pick" });
    }
  }, [jobsState, initialJobId]);

  const submitNote = useCallback(
    async (job: Job0, option: WorkerCaptureOption) => {
      if (!obsTitle.trim()) return;
      setObsSubmitting(true);
      setObsError(null);
      const extras =
        option.type === "variation"
          ? {
              askedBy: obsAskedBy,
              labourHours: obsLabourHours.trim() ? Number(obsLabourHours) : null,
              materialsNote: obsMaterialsNote,
            }
          : undefined;
      const r = await createObservation(
        job.id,
        buildObservationPayload(option, obsTitle, obsDescription, extras),
      );
      setObsSubmitting(false);
      if (!r.ok) {
        setObsError(
          // A timed-out write MAY have landed — "may not have sent", never
          // "wasn't sent" (#139, P7). A dropped connection definitely didn't.
          r.error.kind === "timeout"
            ? r.error.message
            : r.error.status === 0
              ? "No connection — your note wasn't sent. Try again when you've got signal."
              : `Couldn't send (${r.error.status}). Try again.`,
        );
        return;
      }
      setNoteFlow({ step: "done", requiresAction: requiresActionForOption(option) });
    },
    [obsTitle, obsDescription, obsAskedBy, obsLabourHours, obsMaterialsNote],
  );

  if (!open) return null;

  const headerBack =
    noteFlow && noteFlow.step === "note"
      ? () => setNoteFlow({ step: "options", job: noteFlow.job })
      : noteFlow && (noteFlow.step === "options" || noteFlow.step === "pick")
        ? () => setNoteFlow(null)
        : null;

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
            {headerBack ? (
              <button
                type="button"
                onClick={headerBack}
                aria-label="Back"
                className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
              >
                <ArrowLeft aria-hidden="true" className="h-5 w-5" />
              </button>
            ) : (
              <Camera aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            )}
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
          ) : submit.v === "done_office" ? (
            /* ── Office item sent ──────────────────────────────────────── */
            <div className="space-y-4 py-4 text-center">
              <CheckCircle2 aria-hidden="true" className="mx-auto h-12 w-12 text-state-success" />
              <div>
                <p className="font-display text-lg text-text">Sent to the office</p>
                <p className="mt-1 text-sm text-text-muted">
                  {submit.photos === 1 ? "1 photo" : `${submit.photos} photos`} + your note are in
                  the office inbox — they&rsquo;ve been notified.
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
          ) : noteFlow ? (
            /* ── No-photo observation loop (unchanged behaviour) ───────── */
            <NoteFlowBody
              flow={noteFlow}
              jobs={jobs}
              title={obsTitle}
              description={obsDescription}
              askedBy={obsAskedBy}
              labourHours={obsLabourHours}
              materialsNote={obsMaterialsNote}
              hasPhotos={photos.length > 0}
              online={online}
              submitting={obsSubmitting}
              error={obsError}
              onPickJob={(j) => {
                // Carry a quick-action option straight to its note step; a
                // plain "log something" pick still lands on the option list.
                if (pendingWorkerOption) {
                  const option = pendingWorkerOption;
                  setPendingWorkerOption(null);
                  setNoteFlow({ step: "note", job: j, option });
                } else {
                  setNoteFlow({ step: "options", job: j });
                }
              }}
              onChooseOption={(job, option) => {
                setObsTitle("");
                setObsDescription("");
                setObsAskedBy("");
                setObsLabourHours("");
                setObsMaterialsNote("");
                setObsError(null);
                setNoteFlow({ step: "note", job, option });
              }}
              onTitle={setObsTitle}
              onDescription={setObsDescription}
              onAskedBy={setObsAskedBy}
              onLabourHours={setObsLabourHours}
              onMaterialsNote={setObsMaterialsNote}
              onSubmit={(job, option) => void submitNote(job, option)}
              onDone={closeWithHistory}
            />
          ) : sharpened && !destOffice ? (
            /* ── Sharpened capture (§2.5, phil_sharpened) — same mechanics,
                  re-skinned. The office destination + note loop fall back to
                  the flows below, unchanged. ── */
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
              rfiQuestion={rfiQuestion}
              onRfiQuestionChange={setRfiQuestion}
              snagTitle={snagTitle}
              onSnagTitleChange={setSnagTitle}
              online={online}
              onWriteNoteInstead={startNoteFlow}
              canWriteNote={jobsState.v === "ready" && jobs.length > 0}
              onSendToOffice={() => setDestOffice(true)}
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
                                onClick={() => {
                                  setSelectedJobId(j.id);
                                  setDestOffice(false);
                                }}
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

                    <button
                      type="button"
                      aria-pressed={destOffice}
                      disabled={submitting}
                      onClick={() => setDestOffice(true)}
                      className={cn(
                        "mt-3 flex w-full items-center gap-3 rounded-card border p-3 text-left",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        destOffice
                          ? "border-brand-navy bg-brand-navy text-text-inverse"
                          : "border-dashed border-border bg-surface text-text hover:bg-surface-subtle",
                      )}
                    >
                      <Building2
                        aria-hidden="true"
                        className={cn(
                          "h-5 w-5 shrink-0",
                          destOffice ? "text-accent-yellow" : "text-text-muted",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-sm font-semibold">
                          Send to the office
                        </span>
                        <span
                          className={cn(
                            "block text-xs",
                            destOffice ? "text-text-inverse/80" : "text-text-muted",
                          )}
                        >
                          Not job related — a fine, damaged gear, paperwork
                        </span>
                      </span>
                      {destOffice ? (
                        <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-yellow" />
                      ) : null}
                    </button>
                  </div>

                  {destOffice ? (
                    /* ── Office details: pick a category + an optional note (the
                       photo carries the rest; the item is auto-titled) ── */
                    <div className="space-y-4">
                      <div>
                        <p className="font-display text-sm font-semibold text-text">What is it?</p>
                        <ul
                          className="mt-2 space-y-2"
                          role="radiogroup"
                          aria-label="What kind of office item is this"
                        >
                          {OFFICE_CAPTURE_OPTIONS.map((o) => {
                            const active = o.key === officeOptionKey;
                            return (
                              <li key={o.key}>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={active}
                                  disabled={submitting}
                                  onClick={() => setOfficeOptionKey(o.key)}
                                  className={cn(
                                    "flex w-full items-center gap-3 rounded-card border p-3 text-left",
                                    "disabled:cursor-not-allowed disabled:opacity-60",
                                    active
                                      ? "border-brand-navy bg-brand-navy text-text-inverse"
                                      : "border-border bg-surface text-text hover:bg-surface-subtle",
                                  )}
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block font-display text-sm font-semibold">
                                      {o.label}
                                    </span>
                                    <span
                                      className={cn(
                                        "block text-xs",
                                        active ? "text-text-inverse/80" : "text-text-muted",
                                      )}
                                    >
                                      {o.hint}
                                    </span>
                                  </span>
                                  {active ? (
                                    <Check
                                      aria-hidden="true"
                                      className="h-5 w-5 shrink-0 text-accent-yellow"
                                    />
                                  ) : null}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>

                      {/* Photo-first: the only field is an OPTIONAL note. The
                          item is auto-titled from the chosen option above, so a
                          photo alone can be sent. */}
                      <label className="block">
                        <span className="font-display text-sm font-semibold text-text">
                          Add a note{" "}
                          <span className="font-normal text-text-muted">(optional)</span>
                        </span>
                        <textarea
                          value={officeDetail}
                          rows={2}
                          onChange={(e) => setOfficeDetail(e.target.value)}
                          disabled={submitting}
                          placeholder="Anything the office needs to know"
                          className={cn(
                            "mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text",
                            "placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none",
                            "disabled:cursor-not-allowed disabled:opacity-60",
                          )}
                        />
                      </label>

                      {officeError ? (
                        <PhilNotice tone="danger" role="alert">
                          {officeError}
                        </PhilNotice>
                      ) : null}

                      <PhilActionButton
                        size="lg"
                        onClick={() => void handleSubmitOffice()}
                        disabled={!canSubmitOffice}
                        aria-busy={submitting}
                      >
                        {submit.v === "submitting"
                          ? `Uploading photo ${submit.current} of ${submit.total}…`
                          : submit.v === "sending"
                            ? "Sending…"
                            : "Send to office"}
                      </PhilActionButton>
                      <p className="text-xs text-text-muted">
                        Goes to the office inbox — they get a notification.
                      </p>
                    </div>
                  ) : (
                  <>
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
                  )}
                </>
              ) : (
                /* Empty tray — no-photo logging stays one tap away. */
                <div>
                  <p className="text-xs uppercase tracking-wider text-text-muted">
                    Or log something
                  </p>
                  {jobsState.v === "loading" ? (
                    <p className="mt-2 flex items-center gap-2 text-sm text-text-muted">
                      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                      Loading your jobs…
                    </p>
                  ) : jobsState.v === "error" ? (
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
                  ) : jobs.length === 0 ? (
                    <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">
                      No jobs assigned to you yet. Ask your PM to add you to a job, then you can
                      capture against it.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={startNoteFlow}
                      className="mt-2 flex w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-display text-sm font-semibold text-text">
                          Log something without a photo
                        </span>
                        <span className="block text-xs text-text-muted">
                          A note, blocker, safety concern, material need…
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The unchanged no-photo observation loop, extracted for readability. */
function NoteFlowBody({
  flow,
  jobs,
  title,
  description,
  askedBy,
  labourHours,
  materialsNote,
  hasPhotos,
  online,
  submitting,
  error,
  onPickJob,
  onChooseOption,
  onTitle,
  onDescription,
  onAskedBy,
  onLabourHours,
  onMaterialsNote,
  onSubmit,
  onDone,
}: {
  flow: NonNullable<NoteFlow>;
  jobs: LaunchableJob[];
  title: string;
  description: string;
  askedBy: string;
  labourHours: string;
  materialsNote: string;
  hasPhotos: boolean;
  online: boolean;
  submitting: boolean;
  error: string | null;
  onPickJob: (job: Job0) => void;
  onChooseOption: (job: Job0, option: WorkerCaptureOption) => void;
  onTitle: (v: string) => void;
  onDescription: (v: string) => void;
  onAskedBy: (v: string) => void;
  onLabourHours: (v: string) => void;
  onMaterialsNote: (v: string) => void;
  onSubmit: (job: Job0, option: WorkerCaptureOption) => void;
  onDone: () => void;
}) {
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  if (flow.step === "pick") {
    return (
      <>
        <p className="text-sm text-text-muted">Which job is this for?</p>
        <ul className="mt-3 space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                onClick={() => onPickJob({ id: j.id, name: j.name })}
                className="flex w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-semibold text-text">
                    {j.name}
                  </span>
                  {j.siteAddress ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                      <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{j.siteAddress}</span>
                    </span>
                  ) : null}
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (flow.step === "options") {
    return (
      <>
        {flow.job.name ? (
          <p className="text-xs text-text-muted">
            For <span className="font-semibold text-text">{flow.job.name}</span>
          </p>
        ) : null}
        <ul className="mt-2 space-y-2">
          {WORKER_CAPTURE_OPTIONS.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                onClick={() => onChooseOption(flow.job, o)}
                className="flex w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-left hover:bg-surface-subtle"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-sm font-semibold text-text">
                    {o.label}
                  </span>
                  <span className="block text-xs text-text-muted">{o.hint}</span>
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (flow.step === "note") {
    return (
      <div className="space-y-3">
        <div>
          <p className="font-display text-base font-semibold text-text">{flow.option.label}</p>
          <p className="text-xs text-text-muted">{flow.option.hint}</p>
        </div>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-text-muted">
            What&rsquo;s the gist?
          </span>
          <input
            type="text"
            value={title}
            maxLength={TITLE_MAX}
            autoFocus
            onChange={(e) => onTitle(e.target.value)}
            placeholder="Short summary (e.g. cable path blocked at riser)"
            className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-text-muted">
            More detail (optional)
          </span>
          <textarea
            ref={descriptionRef}
            value={description}
            rows={3}
            maxLength={OBSERVATION_DESCRIPTION_MAX}
            onChange={(e) => onDescription(e.target.value)}
            placeholder="Anything the office needs to know"
            className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
          />
        </label>
        <PhilDictateButton
          value={description}
          onAppend={onDescription}
          max={OBSERVATION_DESCRIPTION_MAX}
          online={online}
          disabled={submitting}
          onFocusField={() => descriptionRef.current?.focus()}
        />
        {flow.option.type === "variation" ? (
          <div className="space-y-3 rounded-card border border-border bg-surface-subtle p-3">
            <p className="text-xs text-text-muted">
              Flag the extra work before you start so the office can say yes or no fast.
            </p>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-text-muted">
                Who asked? (optional)
              </span>
              <input
                type="text"
                value={askedBy}
                maxLength={TITLE_MAX}
                onChange={(e) => onAskedBy(e.target.value)}
                placeholder="e.g. site foreman Dave"
                className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-text-muted">
                Rough labour hours (optional)
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={labourHours}
                onChange={(e) => onLabourHours(e.target.value)}
                placeholder="e.g. 4"
                className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-text-muted">
                Materials (optional)
              </span>
              <textarea
                value={materialsNote}
                rows={2}
                onChange={(e) => onMaterialsNote(e.target.value)}
                placeholder="What extra gear or material this needs"
                className="mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text"
              />
            </label>
            {!hasPhotos ? (
              <p className="text-xs text-text-muted">
                Tip: snap a photo of the area before you start the extra work.
              </p>
            ) : null}
          </div>
        ) : null}
        {flow.option.type === "variation" ? (
          <p className="text-xs text-text-muted">
            The office will see this and decide — don&rsquo;t start the extra work yet.
          </p>
        ) : requiresActionForOption(flow.option) ? (
          <p className="text-xs text-text-muted">This goes to the office for review.</p>
        ) : (
          <p className="text-xs text-text-muted">This is saved to the job&rsquo;s history.</p>
        )}
        {error ? (
          <PhilNotice tone="danger" role="alert">
            {error}
          </PhilNotice>
        ) : null}
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!title.trim() || submitting}
          onClick={() => onSubmit(flow.job, flow.option)}
        >
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : (
            "Send to BuhlOS"
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-4 text-center">
      <CheckCircle2 aria-hidden="true" className="mx-auto h-12 w-12 text-state-success" />
      <div>
        <p className="font-display text-lg text-text">Sent to BuhlOS</p>
        <p className="mt-1 text-sm text-text-muted">
          {flow.requiresAction
            ? "The office will review this — it's in their Observations inbox now."
            : "Saved to this job's history."}
        </p>
      </div>
      <Button type="button" variant="primary" size="lg" className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
