"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Building2, Camera, Check, ChevronRight, Loader2, MapPin } from "lucide-react";
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
import { createSnag } from "@/domains/snags/client";
import { SNAG_EVIDENCE_LINK_MAX, SNAG_TITLE_MAX } from "@/domains/snags/schema";
import { philRaiseRfi } from "@/domains/rfi/client";
import { philWrite } from "@/domains/phil/write-client";
import { httpGet } from "@/lib/http";
import { JobContactsResponseSchema } from "@/domains/contacts/schema";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { LaunchableJob } from "./philCapture";
import {
  buildBlockingObservationPayload,
  canMarkBlocked,
  CAPTURE_PURPOSES,
  deriveRfiSubject,
  noteForPurpose,
  purposeByKey,
  RFI_OFFICE_RECIPIENT,
  RFI_QUESTION_MAX,
  rfiPhotoNote,
  rfiRecipients,
  type CapturePurposeKey,
  type RfiRecipient,
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
 *   - Snag = the existing snag write with the saved photos linked.
 *   - RFI = the real register raise (field-gated, api/rfis.js) + optionally
 *     the real blocking observation (task-scoped only — see canMarkBlocked).
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
  rfiQuestion: string;
  onRfiQuestionChange: (v: string) => void;
  snagTitle: string;
  onSnagTitleChange: (v: string) => void;

  online: boolean;

  /** The preserved no-photo observation loop ("write a note instead"). */
  onWriteNoteInstead: () => void;
  canWriteNote: boolean;
  /** The preserved not-job-related "send to the office" destination. */
  onSendToOffice: () => void;

  /** closeWithHistory from the launcher. */
  onClose: () => void;
}

type SharpSubmit =
  | { v: "idle" }
  | { v: "sending"; detail: string }
  | { v: "failed"; message: string }
  | {
      v: "saved";
      kind: "photos" | "snag";
      savedPhotos: number;
      jobName: string;
      areaName: string | null;
      purposeLabel: string;
    }
  | {
      v: "rfi_sent";
      rfiRef: string;
      jobName: string;
      areaName: string | null;
      blocked: boolean;
      savedPhotos: number;
    };

type RecipientsState =
  | { v: "loading" }
  | { v: "failed" }
  | { v: "ready"; list: RfiRecipient[] };

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
  rfiQuestion,
  onRfiQuestionChange,
  snagTitle,
  onSnagTitleChange,
  online,
  onWriteNoteInstead,
  canWriteNote,
  onSendToOffice,
  onClose,
}: PhilCaptureSharpenedProps) {
  const [submit, setSubmit] = useState<SharpSubmit>({ v: "idle" });
  const [changingJob, setChangingJob] = useState(false);
  const [recipients, setRecipients] = useState<RecipientsState>({ v: "loading" });
  const [recipientKey, setRecipientKey] = useState(RFI_OFFICE_RECIPIENT.key);
  const [markBlocked, setMarkBlocked] = useState(false);

  // Cross-retry memory so a resumed submit never double-writes what already
  // landed: photos saved as evidence keep their ids; a created blocking
  // observation keeps its id (the RFI retry reuses it instead of re-creating).
  const savedEvidenceIdsRef = useRef<string[]>([]);
  const observationIdRef = useRef<string | null>(null);
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

  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const areaName = areaId ? (flatAreas.find((a) => a.id === areaId)?.name ?? null) : null;
  const readyPhotos = photos.filter((p) => p.status === "ready" && p.dataUrl);
  const resizing = photos.some((p) => p.status === "resizing");
  const latestPreview = [...readyPhotos].reverse()[0] ?? null;
  const busy = submit.v === "sending";
  const rfiSubject = deriveRfiSubject(rfiQuestion);
  const blockable = canMarkBlocked(stage, areaId, taskId);

  // A fresh purpose = a fresh write chain. Clears the cross-retry memory so a
  // half-finished RFI attempt never leaks its observation into a snag save.
  const switchPurpose = useCallback(
    (p: CapturePurposeKey) => {
      onPurposeChange(p);
      savedEvidenceIdsRef.current = [];
      observationIdRef.current = null;
      setSubmit((s) => (s.v === "failed" ? { v: "idle" } : s));
    },
    [onPurposeChange],
  );

  // Real recipients for the RFI branch: Office/PM always; the job's
  // categorised `project` contacts (the "Who to call" rows). Fail-soft —
  // Office/PM stays available and we say the list didn't load (P7).
  useEffect(() => {
    if (purpose !== "rfi" || !selectedJobId) return;
    let cancelled = false;
    setRecipients({ v: "loading" });
    setRecipientKey(RFI_OFFICE_RECIPIENT.key);
    void httpGet(`/api/contacts?jobId=${encodeURIComponent(selectedJobId)}`, {
      schema: JobContactsResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setRecipients({ v: "failed" });
        return;
      }
      setRecipients({ v: "ready", list: rfiRecipients(r.data.contacts) });
    });
    return () => {
      cancelled = true;
    };
  }, [purpose, selectedJobId]);

  const recipientList =
    recipients.v === "ready" ? recipients.list : [RFI_OFFICE_RECIPIENT];
  const recipient =
    recipientList.find((r) => r.key === recipientKey) ?? RFI_OFFICE_RECIPIENT;

  const canSave =
    !busy &&
    !resizing &&
    !!selectedJob &&
    (purpose === "snag"
      ? snagTitle.trim().length > 0
      : purpose === "rfi"
        ? rfiQuestion.trim().length > 0
        : readyPhotos.length > 0) &&
    note.length <= EVIDENCE_NOTE_MAX;

  /** Save the tray through the existing two-step evidence path. Returns true
   *  when every photo landed; failures stay in the tray with their message. */
  const saveBatch = useCallback(
    async (caption: string): Promise<boolean> => {
      if (!selectedJob) return false;
      const batch = readyPhotos.map((p) => ({ id: p.id, dataUrl: p.dataUrl! }));
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
      const failedById = new Map<string, string>();
      for (const r of result.results) {
        if (!r.ok) failedById.set(r.id, r.message);
      }
      if (mountedRef.current) {
        setPhotos((cur) =>
          cur
            .filter((p) => failedById.has(p.id) || p.status !== "ready")
            .map((p) =>
              failedById.has(p.id)
                ? { ...p, status: "failed" as const, error: failedById.get(p.id) }
                : p,
            ),
        );
      }
      if (!result.allSaved) {
        const n = result.failedIds.length;
        safeSetSubmit({
          v: "failed",
          message: `${n === 1 ? "One photo" : `${n} photos`} didn't save — ${n === 1 ? "it's" : "they're"} still here. Nothing else was sent.`,
        });
        return false;
      }
      return true;
    },
    [selectedJob, readyPhotos, stage, areaId, taskId, setPhotos, safeSetSubmit],
  );

  const handleSave = useCallback(async () => {
    if (!canSave || !selectedJob) return;

    if (purpose === "progress" || purpose === "covered") {
      const ok = await saveBatch(noteForPurpose(purpose, note));
      if (!ok) return;
      safeSetSubmit({
        v: "saved",
        kind: "photos",
        savedPhotos: savedEvidenceIdsRef.current.length,
        jobName: selectedJob.name,
        areaName,
        purposeLabel: purposeByKey(purpose).label,
      });
      savedEvidenceIdsRef.current = [];
      onNoteChange("");
      return;
    }

    if (purpose === "snag") {
      const ok = await saveBatch(noteForPurpose("progress", note));
      if (!ok) return;
      safeSetSubmit({ v: "sending", detail: "Raising the snag…" });
      const res = await createSnag(selectedJob.id, {
        title: snagTitle.trim().slice(0, SNAG_TITLE_MAX),
        description: note.trim() ? note.trim() : null,
        priority: "normal",
        stage,
        areaId,
        taskId,
        evidenceIds: savedEvidenceIdsRef.current.slice(0, SNAG_EVIDENCE_LINK_MAX),
      });
      if (!res.ok) {
        safeSetSubmit({
          v: "failed",
          message:
            res.error.status === 0
              ? "Couldn't reach the office — the snag wasn't raised. Your photos are already on the job. Try again."
              : `Couldn't raise the snag (${res.error.status}). Your photos are already on the job. Try again.`,
        });
        return;
      }
      safeSetSubmit({
        v: "saved",
        kind: "snag",
        savedPhotos: savedEvidenceIdsRef.current.length,
        jobName: selectedJob.name,
        areaName,
        purposeLabel: "Snag",
      });
      savedEvidenceIdsRef.current = [];
      onSnagTitleChange("");
      onNoteChange("");
      return;
    }

    // RFI — photos (if any) → optional blocking observation → the raise.
    const subject = rfiSubject;
    const ok = await saveBatch(rfiPhotoNote(subject));
    if (!ok) return;

    let blocked = false;
    if (markBlocked && blockable && stage && areaId && taskId) {
      if (!observationIdRef.current) {
        safeSetSubmit({ v: "sending", detail: "Marking the work blocked…" });
        const obs = await philWrite<{ id: string }>(
          `/api/observations?jobId=${encodeURIComponent(selectedJob.id)}`,
          buildBlockingObservationPayload({
            subject,
            question: rfiQuestion.trim(),
            stage,
            areaId,
            taskId,
            linkedEvidenceId: savedEvidenceIdsRef.current[0] ?? null,
          }),
          (raw) => {
            const o = (raw as { observation?: { id?: unknown } } | null)?.observation;
            return o && typeof o.id === "string" ? { id: o.id } : null;
          },
        );
        if (!obs.ok) {
          safeSetSubmit({
            v: "failed",
            message: `Couldn't mark the work blocked — the RFI wasn't sent yet. ${obs.error.message}`,
          });
          return;
        }
        observationIdRef.current = obs.data.id;
      }
      blocked = true;
    }

    safeSetSubmit({ v: "sending", detail: "Sending the RFI…" });
    const raised = await philRaiseRfi(selectedJob.id, {
      subject,
      question: rfiQuestion.trim().slice(0, RFI_QUESTION_MAX),
      askedOf: recipient.askedOf || undefined,
      areaId,
      observationId: observationIdRef.current,
    });
    if (!raised.ok) {
      safeSetSubmit({
        v: "failed",
        message:
          raised.error.kind === "http" && raised.error.status === 404
            ? "The RFI register isn't switched on for your company yet — send it as a question for the office from the note flow instead."
            : raised.error.message,
      });
      return;
    }
    safeSetSubmit({
      v: "rfi_sent",
      rfiRef: raised.data.ref,
      jobName: selectedJob.name,
      areaName,
      blocked,
      savedPhotos: savedEvidenceIdsRef.current.length,
    });
    savedEvidenceIdsRef.current = [];
    observationIdRef.current = null;
    onRfiQuestionChange("");
    setMarkBlocked(false);
  }, [
    canSave,
    selectedJob,
    purpose,
    note,
    snagTitle,
    rfiQuestion,
    rfiSubject,
    stage,
    areaId,
    taskId,
    areaName,
    markBlocked,
    blockable,
    recipient,
    saveBatch,
    safeSetSubmit,
    onNoteChange,
    onSnagTitleChange,
    onRfiQuestionChange,
  ]);

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
        <PhilSyncBanner
          state="saved"
          detail={
            submit.kind === "snag"
              ? `Snag raised on ${[submit.jobName, submit.areaName].filter(Boolean).join(" · ")}.${
                  photosLine ? ` ${photosLine}` : ""
                }`
              : photosLine ?? undefined
          }
        />
        <PhilActionButton size="lg" onClick={captureAnother}>
          Capture another
        </PhilActionButton>
        <Button type="button" variant="secondary" size="lg" className="w-full" onClick={onClose}>
          {fromJobContext ? "Back to the job" : "Done"}
        </Button>
      </div>
    );
  }

  if (submit.v === "rfi_sent") {
    return (
      <div className="space-y-4" data-testid="phil-capture-sharpened-rfi-sent">
        <div className="rounded-card border border-state-info-subtle-border bg-state-info-subtle-bg p-3.5 text-state-info-subtle-text">
          <p className="font-display text-[15px] font-bold leading-snug">RFI sent</p>
          <p className="mt-1 text-[13px] leading-snug">
            <span className="font-mono font-semibold">{submit.rfiRef}</span> logged on{" "}
            {[submit.jobName, submit.areaName].filter(Boolean).join(" · ")} — the office has it.
            Awaiting an answer.
          </p>
          {submit.blocked ? (
            <p className="mt-1 text-[13px] leading-snug">
              Work here is marked blocked until it&rsquo;s answered.
            </p>
          ) : null}
          {submit.savedPhotos > 0 ? (
            <p className="mt-1 text-[13px] leading-snug">
              {submit.savedPhotos === 1 ? "1 photo" : `${submit.savedPhotos} photos`} filed to the
              job alongside it.
            </p>
          ) : null}
        </div>
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

      {/* Snag branch — the existing snag-raise path, inlined. */}
      {purpose === "snag" ? (
        <label className="block">
          <span className="font-display text-sm font-semibold text-text">
            What&rsquo;s wrong?
          </span>
          <input
            type="text"
            value={snagTitle}
            maxLength={SNAG_TITLE_MAX}
            disabled={busy}
            onChange={(e) => onSnagTitleChange(e.target.value)}
            placeholder="Short — e.g. GPO ring damaged at riser"
            data-testid="capture-snag-title"
            className={cn(
              "mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text",
              "placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <span className="mt-1 block text-[12px] text-text-muted">
            Goes on the job&rsquo;s snag list — the office sees it.
          </span>
        </label>
      ) : null}

      {/* RFI branch — question + real recipients + honest blocking. */}
      {purpose === "rfi" ? (
        <div className="space-y-4" data-testid="capture-rfi-branch">
          <div>
            <label
              htmlFor="capture-rfi-question"
              className="font-display text-sm font-semibold text-text"
            >
              What do you need answered?
            </label>
            <textarea
              id="capture-rfi-question"
              ref={questionRef}
              value={rfiQuestion}
              rows={3}
              maxLength={RFI_QUESTION_MAX}
              disabled={busy}
              onChange={(e) => onRfiQuestionChange(e.target.value)}
              placeholder="Plain words — what's unclear, and where"
              className={cn(
                "mt-2 block w-full rounded-card border border-border bg-surface px-3 py-2 text-base text-text",
                "placeholder:text-text-muted/70 focus:border-brand-navy focus:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            />
            <div className="mt-2">
              <PhilDictateButton
                value={rfiQuestion}
                onAppend={onRfiQuestionChange}
                max={RFI_QUESTION_MAX}
                online={online}
                disabled={busy}
                onFocusField={() => questionRef.current?.focus()}
              />
            </div>
          </div>

          <fieldset>
            <legend className="font-display text-sm font-semibold text-text">Send it to</legend>
            {recipients.v === "loading" ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-text-muted">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                Checking the job&rsquo;s contacts…
              </p>
            ) : null}
            <ul className="mt-2 space-y-1.5" role="radiogroup" aria-label="Send it to">
              {recipientList.map((r) => {
                const active = r.key === recipientKey;
                return (
                  <li key={r.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={busy}
                      onClick={() => setRecipientKey(r.key)}
                      className={cn(
                        "flex min-h-[48px] w-full items-center gap-3 rounded-card border px-3 py-2 text-left",
                        "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                        active
                          ? "border-brand-navy bg-brand-navy text-text-inverse"
                          : "border-border bg-surface text-text hover:bg-surface-subtle",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-sm font-semibold">
                          {r.label}
                        </span>
                        {r.detail ? (
                          <span
                            className={cn(
                              "block truncate text-[12px]",
                              active ? "text-text-inverse/80" : "text-text-muted",
                            )}
                          >
                            {r.detail}
                          </span>
                        ) : null}
                      </span>
                      {active ? (
                        <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-yellow" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {recipients.v === "failed" ? (
              <p className="mt-1.5 text-[12px] text-text-muted">
                Couldn&rsquo;t load the job&rsquo;s contacts — the office will route it.
              </p>
            ) : null}
          </fieldset>

          {blockable ? (
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-card border border-border bg-surface px-3 py-2">
              <input
                type="checkbox"
                checked={markBlocked}
                disabled={busy}
                onChange={(e) => setMarkBlocked(e.target.checked)}
                data-testid="capture-rfi-block"
                className="h-5 w-5 shrink-0 accent-brand-navy"
              />
              <span className="text-sm text-text">
                Mark the affected work <span className="font-semibold">blocked</span> until
                it&rsquo;s answered
              </span>
            </label>
          ) : (
            <p className="text-[12px] text-text-muted" data-testid="capture-rfi-block-hint">
              To mark work blocked until the answer, pick the stage, area and task under
              &ldquo;Filed to&rdquo;.
            </p>
          )}
        </div>
      ) : null}

      {/* Note — the photo caption the office sees (hidden for RFI, where the
          question is the text and the photos carry an "RFI: …" caption). */}
      {purpose !== "rfi" ? (
        <div>
          <label
            htmlFor="capture-sharpened-note"
            className="font-display text-sm font-semibold text-text"
          >
            {purpose === "snag" ? (
              <>
                More detail <span className="font-normal text-text-muted">(optional)</span>
              </>
            ) : (
              <>
                Note <span className="font-normal text-text-muted">(optional)</span>
              </>
            )}
          </label>
          <textarea
            id="capture-sharpened-note"
            ref={noteRef}
            value={note}
            rows={2}
            maxLength={EVIDENCE_NOTE_MAX}
            disabled={busy}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={
              purpose === "snag" ? "Anything the fixer needs to know" : "What do these photos show?"
            }
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
      ) : null}

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

        {/* The preserved not-job-related destination. */}
        {photos.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={onSendToOffice}
            className={cn(
              "mt-3 flex min-h-[48px] w-full items-center gap-3 rounded-card border border-dashed border-border bg-surface p-3 text-left",
              "hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <Building2 aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-sm font-semibold text-text">
                Send to the office instead
              </span>
              <span className="block text-[12px] text-text-muted">
                Not job related — a fine, damaged gear, paperwork
              </span>
            </span>
          </button>
        ) : null}
      </div>

      {submit.v === "sending" ? <PhilSyncBanner state="sending" detail={submit.detail} /> : null}
      {submit.v === "failed" ? (
        <PhilSyncBanner state="failed" detail={submit.message} onRetry={() => void handleSave()} />
      ) : null}

      <PhilActionButton
        size="lg"
        onClick={() => void handleSave()}
        disabled={!canSave}
        aria-busy={busy}
        data-testid="capture-sharpened-save"
      >
        {busy
          ? "Sending…"
          : purpose === "rfi"
            ? "Send RFI to the office"
            : purpose === "snag"
              ? "Save & raise the snag"
              : "Save & file to job"}
      </PhilActionButton>

      {canWriteNote ? (
        <button
          type="button"
          disabled={busy}
          onClick={onWriteNoteInstead}
          data-testid="capture-write-note-instead"
          className={cn(
            "flex min-h-[44px] w-full items-center justify-center rounded-card border border-border bg-surface px-4",
            "text-sm font-semibold text-text hover:bg-surface-subtle",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          No photo — write a note instead
        </button>
      ) : null}
    </div>
  );
}
