"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { Camera, ClipboardList, Images, Map as MapIcon, Zap } from "lucide-react";
import { scheduleSummaryLine } from "@/domains/circuit-schedule/format";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { moduleEnabled } from "@/domains/jobs/builder";
import { visibleAreaGroups } from "@/domains/jobs/format";
import {
  applyTaskState,
  parseTaskToggleResult,
  type JobTaskState,
  type TaskState,
} from "@/domains/jobs/taskState";
import { buildCanonicalTaskIndex } from "@/domains/jobs/task-index";
import { rollUpTaskProgress } from "@/domains/jobs/task-progress-rollup";
import {
  philTaskReadinessByTemplateId,
  workerTasksFromCanonicalIndex,
} from "@/domains/jobs/phil-task-projection";
import { taskBlockersFromObservations } from "@/domains/observations/task-blockers";
import { buildPhilJobCommandModel } from "@/domains/phil/job-command-model";
import { philJobCommandInputFromJobData } from "@/domains/phil/job-command-input";
import { philWrite } from "@/domains/phil/write-client";
import { confirmInduction, type InductionRecord } from "@/domains/jobs/induction";
import { JobTagsPanel } from "./JobTagsPanel";
import { buildAreaTaskContext } from "./philTaskContext";
import { linkAndApply, type ProofActionStatus } from "./jobControlEvidenceLinkClient";
import {
  submitProofForReview,
  type ProofSubmitStatus,
} from "./jobControlProofReviewClient";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import { PhilJobServicesCard } from "./PhilJobServicesCard";
import { taskRefKey } from "@/domains/job-control/spine";
import { canAddServiceLocation } from "@/domains/services-locations/permissions";
import type { JobContact } from "@/domains/contacts/schema";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";
import type { TagItem } from "@/domains/tags/schema";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { EvidenceLink, ProofReview, TaskRef, WorkPackage } from "@/domains/job-control/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";
import { filterSpecsByArea, isCurrent } from "@/domains/documents/format";
import { CaptureSheet } from "./CaptureSheet";
import { PhilTestRecordCard, type TestRecordDraft } from "./PhilTestRecordCard";
import { submitTestRecord } from "./testRecordClient";
import { ReportSnagSheet } from "./ReportSnagSheet";
import type { TestRecordRow } from "@/domains/test-records/schema";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobSnagsPanel } from "./JobSnagsPanel";
import { JobItpPanel } from "./JobItpPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
import { PhilJobCrewCard } from "./PhilJobCrewCard";
import { PhilJobHero } from "./PhilJobHero";
import { PhilSafetyHomeSection } from "./PhilSafetyHomeSection";
import { PhilCertificatesHomeSection } from "./PhilCertificatesHomeSection";
import { PhilJobCommandPanel } from "./PhilJobCommandPanel";
import { PhilJobAttentionStrip } from "./PhilJobAttentionStrip";
import { PhilJobAreaCard } from "./PhilJobAreaCard";
import { PhilJobAreaDetail } from "./PhilJobAreaDetail";
import { useCaptureLauncher } from "./captureLauncherContext";
import { readJobResume, writeJobResume } from "./jobResume";
import {
  areaStageAvailability,
  buildAreaCountMaps,
  countsForArea,
  soleStage,
} from "./philJobWorkTree";
import { deriveAttention } from "./PhilJobAttention";
import {
  blockedCountByArea,
  blockedTasks,
  jobWorkCounts,
  owedProofCountByArea,
  owedProofItems,
  type PhilJobRoom,
} from "./philJobRooms";
import { usePhilJobRoomsBarRegistration } from "./philJobRoomsBar";
import { PhilJobRoomsView } from "./PhilJobRoomsView";
import { PhilJobRoomArea } from "./PhilJobRoomArea";

interface Props {
  job: Job;
  /** Initial evidence list fetched server-side (server filters to own
   *  captures for tradie; admin/LH see all). May be empty on load. */
  initialEvidence?: ReadonlyArray<EvidenceItem>;
  /** Initial snags list fetched server-side. May be empty. */
  initialSnags?: ReadonlyArray<SnagItem>;
  /** Initial observations fetched server-side (#504). Source for real task
   *  blockers: an open, task-scoped, blocking-type observation marks its task
   *  `blocked` in the readiness display. Absent/empty ⇒ nothing blocked (honest
   *  empty, exactly as today). */
  initialObservations?: ReadonlyArray<ObservationItem>;
  /** Initial ITP instances list fetched server-side (Phase E1b).
   *  May be empty on load. */
  initialItps?: ReadonlyArray<ITPInstance>;
  /** Initial documents (plans + specs) fetched server-side (Phase E2).
   *  May be empty on load. */
  initialDocuments?: ReadonlyArray<Document>;
  /** Initial test & tag entries fetched server-side (#388). May be empty. */
  initialTags?: ReadonlyArray<TagItem>;
  /** Categorised job contacts fetched server-side (#189). May be empty. */
  initialContacts?: ReadonlyArray<JobContact>;
  /** Services-locations records fetched server-side (#230 — where the pit/
   *  board/meter/temp-supply are). May be empty. */
  initialServiceLocations?: ReadonlyArray<ServiceLocationRecord>;
  /** Non-blocking error from the services-locations fetch — surfaces a quiet
   *  notice inside the card. Null when the fetch succeeded. */
  serviceLocationsError?: string | null;
  /** This worker's latest induction record on this job (#332), loaded
   *  server-side. Null = no record; undefined = not loaded (falls back to
   *  the static warning — the safe direction). */
  initialMyInduction?: InductionRecord | null;
  /** True when the tags fetch FAILED (vs returning empty) — keeps the
   *  command signal honest (`unknown`, not a misleading 0). */
  tagsError?: boolean;
  /** Non-blocking error from the documents fetch — surfaces an info
   *  bar inside JobDocumentsPanel. Null when the fetch succeeded. */
  documentsError?: string | null;
  /** Initial worker-visible task state (areaId → stage → taskId → state),
   *  parsed server-side from the job's data blob. Empty when unavailable. */
  initialTaskState?: JobTaskState;
  /** Non-blocking error from the task-state fetch. When set, the task rows
   *  still render from the plan, but the worker is told progress may be stale. */
  taskStateError?: string | null;
  /** Perf (Phil mobile job-detail LCP): when present, the (slow) task state is
   *  STREAMED rather than passed as a resolved value — the job structure paints
   *  first and this resolves into `taskState` behind a nested <Suspense>, with the
   *  selected area's task list showing a skeleton until it lands (never a false
   *  "to do"). Flag-on path only; flag-off passes `initialTaskState` as today. */
  taskStatePromise?: Promise<{ state: JobTaskState; error: string | null }>;
  /** Current viewer — id + role drive snag transition button gating
   *  and attention-strip filters (e.g. "snags assigned to me"). */
  viewer?: { id: string; role: string };
  /** Compiled work packages for this job (L2 read of `job-control.json`),
   *  loaded server-side. Drives per-task scope context (#368) via
   *  `buildAreaTaskContext`. Absent/empty ⇒ every task renders exactly as today
   *  (zero regression — honest empty). */
  workPackages?: ReadonlyArray<WorkPackage>;
  /** Compiled evidence links for this job (L2 read). A required-evidence item
   *  reads `met` ONLY when a real link names it — never a count. Seeds client
   *  state so a successful proof link flips it to met without a full reload. */
  evidenceLinks?: ReadonlyArray<EvidenceLink>;
  /** Task-instance proof reviews for this job (#503). Drives the per-task review
   *  status + the "Submit for review" affordance. Absent/empty ⇒ no task has been
   *  submitted (the default). */
  proofReviews?: ReadonlyArray<ProofReview>;
  /** Current job-control artifact revision (#469 stale-write precondition).
   *  Required to capture proof for a requirement; absent ⇒ the capture
   *  affordance is hidden. */
  jobControlRevision?: string;
  /** When set (and changing), auto-opens the capture sheet. Driven by
   *  the `?capture=<token>` deep link the global Capture launcher
   *  (PhilTabBar FAB) pushes, so a worker can start a capture from
   *  anywhere in Phil in one tap. A fresh token re-opens on repeat taps. */
  autoCaptureToken?: string | null;
  /** #219: mount the hidden-until-real Safety home section (flag-gated by the page). */
  safetyEnabled?: boolean;
  /** #231: mount the hidden-until-real Certificates home section (flag-gated by the page). */
  certificatesEnabled?: boolean;
  /** `itp` flag (lean reset), resolved by the page: mount the ITPs section only
   *  while the feature is live — its API (api/job-itps.js) 404s when dark. */
  itpEnabled?: boolean;
  /** `itp_simple` flag (#912): mount the simple ITP builder link-out only when
   *  live — the /phil/jobs/[jobId]/itp-reports route + API 404 while dark. */
  itpSimpleEnabled?: boolean;
  /** `snags` flag (lean reset), resolved by the page: mount the Snags section
   *  only while the feature is live — its API (api/snags.js) 404s when dark. */
  snagsEnabled?: boolean;
  /**
   * phil_job_rooms (dark — the filed #133 experiment): render this job as the
   * FOUR ROOMS takeover (Now · Work · [Capture] · Proof · Site with the in-job
   * bottom bar) instead of the one-scroll page. Resolved SERVER-SIDE via
   * philSharpenedFlags (which enforces jobRooms ⇒ sharpened) and passed as a
   * boolean. False/absent = the current job screen, byte-identical. The rooms
   * are in-page client state on this same route — no new URLs.
   */
  rooms?: boolean;
}

/**
 * Phil single-job context view.
 *
 * Layout (top to bottom) — restructured per the Phil Job Interface
 * Bible §08 "Job Home" pattern:
 *
 *   1. Back link → /phil/jobs
 *   2. <PhilJobHero/> — job name + status pill + address summary
 *   3. <PhilJobCommandPanel/> — "Quick actions": the model-driven
 *      (#96) primary action + ranked secondary actions + honest
 *      limitations, plus a hard-blocker notice. Replaces the old flat
 *      section-anchor strip (the panel's actions jump to the same
 *      in-page sections, prioritised, with a primary CTA).
 *   4. <PhilJobAttentionStrip/> — strict, max 3, viewer-scoped real
 *      signals (rejected / assigned-to-me snags, pending ITPs,
 *      induction). Hidden when nothing qualifies. Attention stays here,
 *      not in the command panel, so the two never duplicate.
 *   5. "Work to do" (#phil-job-work) — stage chooser + area picker +
 *      effective task list + per-task toggle. The active work, led first.
 *   6. Capture block (#phil-job-capture) — primary CTA + today's
 *      capture strip. ("Capture evidence" — kept verbatim; smoke/e2e
 *      match this button + the CaptureSheet dialog name.)
 *   7. Snags (#phil-job-snags) — JobSnagsPanel; flag-gated (`snags`,
 *      lean reset) — mounted only while the feature is live.
 *   8. ITPs (#phil-job-itps) — JobItpPanel; flag-gated (`itp`, lean reset) —
 *      mounted only while the feature is live.
 *   8b. Simple ITP builder link-out (#phil-job-itp-reports) — flag-gated
 *      (`itp_simple`, #912); a Card link to /itp-reports, no inline panel.
 *   9. Plans (#phil-job-plans) — in-app drawing viewer link.
 *  10. Documents (#phil-job-documents) — JobDocumentsPanel (live, E2
 *      read-only — "Site files"; backed by the ungated /api/plans read).
 *  11. <PhilJobSiteCard/> "Site details" (#phil-job-site) — reference info
 *      (address / contact / access / parking / safety / induction),
 *      collapsible. Demoted to the bottom reference zone so the active work
 *      loop leads; keeps #phil-job-site for the induction attention link.
 *
 * Section ORDER is the worker flow: do the work → capture proof → handle
 * problems/checks → references (plans/docs) → site details. Dark features
 * leave NO trace — no notes, no fake counts, no "under construction" cards.
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html
 *     §08 Job Home, §07 Needs Attention doctrine, §13 field rules
 *   docs/rebuild-audit/27-interface-usability-pass.md §4 + §8.5
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §3 + §7
 */
export function PhilJobDetail({
  job,
  initialEvidence,
  initialSnags,
  initialObservations,
  initialItps,
  initialDocuments,
  documentsError,
  initialTags,
  tagsError,
  initialContacts,
  initialServiceLocations,
  serviceLocationsError,
  initialMyInduction,
  initialTaskState,
  taskStateError,
  taskStatePromise,
  viewer,
  workPackages,
  evidenceLinks: initialEvidenceLinks,
  proofReviews: initialProofReviews,
  jobControlRevision,
  autoCaptureToken,
  safetyEnabled = false,
  certificatesEnabled = false,
  itpEnabled = false,
  itpSimpleEnabled = false,
  snagsEnabled = false,
  rooms = false,
}: Props) {
  // Opens the global Capture launcher preset to one option (here, the
  // "Variation / change" worker option) — the SAME flow My Day's quick tiles
  // use. The launcher (mounted in PhilTabBar, inside PhilShell) resolves THIS
  // job from the /phil/jobs/<id> path, so a flag from a task lands on the right
  // job's variation capture. No new variation form, no fabricated #369 fields.
  const { openQuickCapture } = useCaptureLauncher();
  // #332: induction completion is server truth — the tap is NON-optimistic
  // (state flips only after the API confirms; a failed save shows the error
  // inside the notice, never a phantom "done").
  const [myInduction, setMyInduction] = useState<InductionRecord | null>(
    initialMyInduction ?? null,
  );
  const [inductionSaving, setInductionSaving] = useState(false);
  const [inductionError, setInductionError] = useState<string | null>(null);
  const handleConfirmInduction = useCallback(async () => {
    setInductionSaving(true);
    setInductionError(null);
    const result = await confirmInduction(job.id);
    setInductionSaving(false);
    if (!result.ok) {
      setInductionError(result.error.message);
      return;
    }
    setMyInduction(result.data.record);
  }, [job.id]);
  const groups = useMemo(() => visibleAreaGroups(job.areaGroups), [job.areaGroups]);

  // Flatten the visible areas across groups so the default selection
  // ("the first thing the worker sees") is stable regardless of how the
  // PM organised the groups.
  const flatAreas = useMemo(
    () =>
      groups.flatMap((g) =>
        (g.areas ?? []).map((a) => ({
          ...a,
          groupName: g.name,
          groupId: g.id,
        }))
      ),
    [groups]
  );

  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(
    flatAreas[0]?.id ?? null
  );
  const [stage, setStage] = useState<JobStage>("roughIn");

  // ── Four-rooms takeover state (phil_job_rooms — #133; in-page, no routes) ──
  // The active room, whether the Work room's area drill-in is open (it reuses
  // selectedAreaId/stage above — one source of truth for "where am I"), and a
  // seq that bumps on every room select so re-selecting the active tab resets
  // the room to its root (nav semantics; the view keys its content off it).
  const [room, setRoom] = useState<PhilJobRoom>("now");
  const [roomAreaOpen, setRoomAreaOpen] = useState(false);
  const [roomResetSeq, setRoomResetSeq] = useState(0);

  const [captureOpen, setCaptureOpen] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<ReadonlyArray<EvidenceItem>>(
    initialEvidence ?? []
  );
  // #230: when the Services card asks for a photo, it gets a promise that
  // resolves with the captured EvidenceItem (or null if the worker cancels /
  // the capture fails). We open the SAME CaptureSheet (no new upload path) and
  // stash the resolver here; handleCaptured / handleCaptureFailed / close
  // resolve it. A ref (not state) so resolving it never triggers a re-render.
  const servicesCaptureResolverRef = useRef<((item: EvidenceItem | null) => void) | null>(
    null,
  );
  const [captureBanner, setCaptureBanner] = useState<
    { tone: "info" | "success" | "danger"; message: string } | null
  >(null);
  // Compiled evidence links as client state, so a successful proof link flips the
  // requirement to met without a full reload. Seeded from the server read.
  const [evidenceLinks, setEvidenceLinks] = useState<ReadonlyArray<EvidenceLink>>(
    initialEvidenceLinks ?? []
  );
  // Task-instance proof reviews as client state (#503), so a submit reflects
  // immediately without a full reload. Seeded from the server read.
  const [proofReviews, setProofReviews] = useState<ReadonlyArray<ProofReview>>(
    initialProofReviews ?? []
  );
  // Transient per-task submit feedback, keyed by taskRefKey.
  const [proofSubmitStatus, setProofSubmitStatus] = useState<Record<string, ProofSubmitStatus>>({});
  // Current artifact revision (advances on each successful link). The capture
  // affordance is hidden when this is absent.
  const [jcRevision, setJcRevision] = useState<string | undefined>(jobControlRevision);
  // The requirement a pending capture is for (workPackageId + requiredEvidenceId
  // + taskId); the area/stage come from the current selection. Cleared on
  // capture/close.
  const [pendingProofLink, setPendingProofLink] = useState<{
    workPackageId: string;
    requiredEvidenceId: string;
    taskId: string;
    /** Set when the captured requirement is task-scoped (#502) — scopes the link. */
    taskRef?: TaskRef;
  } | null>(null);
  // Per-requirement (requiredEvidenceId → status) capture/link feedback.
  const [proofStatus, setProofStatus] = useState<Record<string, ProofActionStatus>>({});

  // #517 — the structured test-record sheet. Opened (instead of the photo/note
  // CaptureSheet) when the tapped required-proof item is a `test_result`. Carries
  // the same pending target so the minted evidence is linked through the EXISTING
  // linkAndApply pathway. `saving` covers the whole save→mint→link round-trip.
  const [testRecordOpen, setTestRecordOpen] = useState(false);
  const [testRecordTarget, setTestRecordTarget] = useState<{
    workPackageId: string;
    requiredEvidenceId: string;
    label?: string;
    taskRef?: TaskRef;
  } | null>(null);
  const [testRecordSaving, setTestRecordSaving] = useState(false);
  const [testRecordError, setTestRecordError] = useState<string | null>(null);
  // #520: after a successful save whose SERVER-derived record has failed
  // circuits, the card shows the failed rows + "Report defect" instead of
  // silently closing. Null on a clean pass (closes exactly as before).
  const [testRecordSaved, setTestRecordSaved] = useState<{
    recordId: string;
    failedRows: TestRecordRow[];
  } | null>(null);
  // #520: the defect sheet opened FROM a failed test result — the existing
  // Report snag sheet, pre-filled with the real readings + the testRecordId.
  const [testDefectSheet, setTestDefectSheet] = useState<{
    prefill: { title: string; description: string };
    testRecordId: string;
    context: { stage: JobStage | null; areaId: string | null };
  } | null>(null);

  // Worker-visible task state (areaId → stage → taskId → state). Seeded from
  // the server-loaded data blob; only ever advanced by a CONFIRMED
  // /api/task-toggle response (never optimistically), so a failed write never
  // shows a task as done.
  const [taskState, setTaskState] = useState<JobTaskState>(initialTaskState ?? {});
  // When the task state is STREAMED (perf — flag-on), it starts PENDING. This is
  // distinct from an empty {} (a brand-new job with no recorded progress): while
  // pending, the selected area's task list shows a skeleton rather than a false
  // "to do", so a DONE task is never briefly mis-shown. The promise resolves into
  // this state via a nested <Suspense> + use() (TaskStateHydrator) below.
  const [taskStatePending, setTaskStatePending] = useState<boolean>(
    Boolean(taskStatePromise),
  );
  // Task-state load error as state (not just a prop) so the streamed resolve can
  // set it. Seeded from the (flag-off) prop; flag-on starts null + pending.
  const [taskStateErr, setTaskStateErr] = useState<string | null>(
    taskStateError ?? null,
  );
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [taskError, setTaskError] = useState<string | null>(null);
  // Seed (does not own) taskState from the streamed read. Toggles still mutate
  // taskState afterwards (non-optimistic), so this only fills the initial value.
  const handleTaskStateResolved = useCallback(
    (resolved: { state: JobTaskState; error: string | null }) => {
      setTaskState(resolved.state ?? {});
      setTaskStateErr(resolved.error ?? null);
      setTaskStatePending(false);
    },
    [],
  );

  // Deep-linked capture: the global Capture button (PhilTabBar) routes
  // here with a fresh ?capture=<token>. Keyed on the token (not a bare
  // boolean) so tapping Capture again for the same job re-opens the sheet.
  const lastCaptureTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoCaptureToken && autoCaptureToken !== lastCaptureTokenRef.current) {
      lastCaptureTokenRef.current = autoCaptureToken;
      setCaptureBanner(null);
      setCaptureOpen(true);
    }
  }, [autoCaptureToken]);

  const selectedArea = useMemo(
    () => flatAreas.find((a) => a.id === selectedAreaId) ?? null,
    [flatAreas, selectedAreaId]
  );

  // The stage actually shown for the selected area: a single-stage area
  // forces its sole stage; a both-stage area follows the parent `stage`
  // selection. Driving the task list + toggle off this (not the raw `stage`)
  // keeps the rows, their state, and the write target in agreement even on
  // first load before any stage tap.
  const selectedStages = useMemo(
    () =>
      selectedArea
        ? areaStageAvailability(job, selectedArea)
        : { roughIn: false, fitOff: false },
    [job, selectedArea],
  );
  const viewedStage: JobStage = soleStage(selectedStages) ?? stage;

  // #196: the specs that govern the selected area (read-only). A spec
  // appears when its admin-set `areaIds` includes this area's id and its
  // stage matches the viewed stage (an unstaged spec governs both). Workers
  // see CURRENT revisions only — same field-safety filter as the documents
  // panel — so a superseded spec never shows on the area. Empty until an
  // admin links one, which keeps the Phil block hidden-when-empty (P10).
  const areaSpecs = useMemo(() => {
    if (!selectedArea) return [] as ReadonlyArray<Document>;
    const current = (initialDocuments ?? []).filter(isCurrent);
    return filterSpecsByArea(current, selectedArea.id, viewedStage);
  }, [initialDocuments, selectedArea, viewedStage]);

  // Resume where you left off (#425 · P8 interruption recovery, P14 memory). On
  // mount, if this job has a remembered area that STILL EXISTS, jump back to it,
  // then keep the memory current as the worker moves. Effect-only (never the
  // initial useState) so server and client first paint agree — no hydration
  // mismatch — and the restore is silently skipped when storage is unavailable.
  const resumeRestoredRef = useRef(false);
  useEffect(() => {
    if (resumeRestoredRef.current) return;
    resumeRestoredRef.current = true;
    const saved = readJobResume(job.id);
    if (saved && flatAreas.some((a) => a.id === saved.areaId)) {
      setSelectedAreaId(saved.areaId);
      setStage(saved.stage);
      // Rooms extension (#133 — "interruption recovery ≤1 gesture"): land back
      // in the last room, with the area drill-in re-opened if it was open.
      if (rooms && saved.room) {
        setRoom(saved.room);
        if (saved.areaOpen && saved.room === "work") setRoomAreaOpen(true);
      }
    }
  }, [job.id, flatAreas, rooms]);

  useEffect(() => {
    if (!selectedAreaId) return;
    // Flag-off writes the exact record it writes today; rooms mode adds the
    // room + drill-in fields so re-entry lands by place.
    writeJobResume(
      job.id,
      rooms
        ? { areaId: selectedAreaId, stage: viewedStage, room, areaOpen: roomAreaOpen }
        : { areaId: selectedAreaId, stage: viewedStage },
    );
  }, [job.id, selectedAreaId, viewedStage, rooms, room, roomAreaOpen]);

  // Canonical task index (#480) for this job — rebuilt only when the plan or the
  // recorded state changes. This is now the SOURCE for the worker task rows
  // (#484): the platform treats a task as a job-level instance keyed by
  // (areaId, stage, taskId) while Phil keeps its area-first view.
  const canonicalTasks = useMemo(
    () => buildCanonicalTaskIndex({ job, taskState }),
    [job, taskState],
  );

  // Whole-job progress rolled up from the canonical index (#507) — the
  // parity-locked path (NOT jobTaskProgress, whose shape differs). Drives the
  // calm job-complete acknowledgement (#427): a quiet "every task is done" note
  // shown ONLY when this is a real, loaded 100% (total > 0 && pct === 100). It is
  // gated below on the task-state load flags so a job whose state is still
  // streaming or failed to load NEVER flashes a false 100% (P7).
  const taskRollup = useMemo(
    () => rollUpTaskProgress(canonicalTasks),
    [canonicalTasks],
  );
  const jobProgress = taskRollup.job;
  const jobComplete =
    !taskStatePending &&
    !taskStateErr &&
    jobProgress.total > 0 &&
    jobProgress.pct === 100;

  // Field-visible tasks for the selected area + viewed stage — projected from the
  // canonical index (filter by source coordinate, render the template id). This
  // is behaviourally identical to the previous buildWorkerTasks path (proven in
  // phil-task-projection.test.ts): same rows, order, state, and toggle target.
  const workerTasks = useMemo(
    () =>
      selectedArea
        ? workerTasksFromCanonicalIndex(canonicalTasks, selectedArea.id, viewedStage)
        : [],
    [canonicalTasks, selectedArea, viewedStage],
  );

  // Real task blockers (#504): derived from this job's observations — an open,
  // task-scoped, blocking-type observation (rfi / variation / material / drawing /
  // client / explicit blocker) becomes a canonical-keyed `TaskBlocker`. Pure +
  // honest: a job with no such observation yields none, so nothing is blocked
  // (exactly as before). Computed once per (observations, job) and fed to the
  // readiness model below; the #493 display lights up only for genuinely-blocked
  // tasks, with no further UI change.
  const jobTaskBlockers = useMemo(
    () => taskBlockersFromObservations({ observations: initialObservations ?? [], jobId: job.id }),
    [initialObservations, job.id],
  );

  // Per-task readiness (#482 model) for the viewed area+stage, keyed by task id —
  // the same key the rows + scope-context use. The row shows a "Blocked — reason"
  // line only when a task resolves to `blocked`. Blockers come from real
  // observations (#504); `deriveTaskReadiness` matches them by canonical task id,
  // so passing the whole-job list is correct (a blocker can sit on any task). When
  // a job has no qualifying observation, this is empty and every not-complete task
  // is `ready` — zero visual change.
  const taskReadinessById = useMemo(
    () =>
      selectedArea
        ? philTaskReadinessByTemplateId({
            canonicalTasks,
            areaId: selectedArea.id,
            stage: viewedStage,
            blockers: jobTaskBlockers,
          })
        : undefined,
    [canonicalTasks, selectedArea, viewedStage, jobTaskBlockers],
  );

  // Per-task scope context (#368) for the viewed area+stage, from the job's
  // compiled work packages (L2 read of `job-control.json`, wired in via props).
  // When a job has no compiled artifact, `workPackages` is empty and the adapter
  // returns an empty map — every task renders exactly as it does today (zero
  // regression). When real compiled data exists, the existing render lights up
  // with no further UI change.
  const taskContextById = useMemo(
    () =>
      selectedArea
        ? buildAreaTaskContext({
            areaId: selectedArea.id,
            stage: viewedStage,
            taskIds: workerTasks.map((t) => t.id),
            workPackages,
            evidenceLinks,
          })
        : undefined,
    [selectedArea, viewedStage, workerTasks, workPackages, evidenceLinks],
  );

  // Mark a task done / not-done via the dedicated fast-path endpoint. Tiny
  // request body (no full-blob re-upload); the server is the single source of
  // truth. Non-optimistic: the row shows a saving state, and local state only
  // advances once the server confirms the new value — so a failed write never
  // leaves a task showing as done.
  const handleToggleTask = useCallback(
    async (taskId: string, next: TaskState) => {
      if (!selectedArea) return;
      const areaId = selectedArea.id;
      const stageForWrite = viewedStage;
      setTaskError(null);
      setPendingTaskIds((prev) => {
        const set = new Set(prev);
        set.add(taskId);
        return set;
      });
      // Routed through philWrite: a bounded 15s timeout (no infinite "saving"
      // spinner), an offline pre-check, and one honest message per failure
      // mode. Still NON-OPTIMISTIC — task state only advances on a confirmed
      // server reply, so a failed write never leaves a task showing as done.
      const result = await philWrite(
        `/api/task-toggle?jobId=${encodeURIComponent(job.id)}`,
        { areaId, stage: stageForWrite, taskId, state: next },
        (raw) => parseTaskToggleResult(raw),
      );
      setPendingTaskIds((prev) => {
        const set = new Set(prev);
        set.delete(taskId);
        return set;
      });
      if (result.ok) {
        setTaskState((prev) =>
          applyTaskState(prev, areaId, stageForWrite, taskId, result.data),
        );
      } else if (result.error.kind !== "cancelled") {
        setTaskError(
          result.error.message ||
            "Couldn't save that change. Check your signal and try again.",
        );
      }
    },
    [job.id, selectedArea, viewedStage],
  );

  // "Quick actions" — the model-driven command panel (replaces the old flat
  // section-anchor strip). Built from the data the page already loaded; the
  // bridge marks anything not derivable here as an honest limitation (e.g.
  // per-job rejected hours isn't fetched on the job screen). Live task state is
  // passed only when it loaded cleanly, so an errored load is never read as
  // "all tasks incomplete"; after a confirmed toggle, the panel updates from the
  // same local state as the task rows.
  const commandModel = useMemo(
    () =>
      buildPhilJobCommandModel(
        philJobCommandInputFromJobData({
          job,
          snags: initialSnags ? [...initialSnags] : undefined,
          itps: initialItps ? [...initialItps] : undefined,
          documents: initialDocuments ? [...initialDocuments] : undefined,
          tags: initialTags ? [...initialTags] : undefined,
          // Pending (still streaming) OR errored → omit task state so the panel
          // shows "View your tasks" (list_only), never a false "N tasks left".
          taskState: taskStateErr || taskStatePending ? undefined : taskState,
          loadErrors: { documents: documentsError != null, tags: tagsError === true },
          myInduction: myInduction ? { completedAt: myInduction.completedAt } : null,
        }),
      ),
    [
      job,
      initialSnags,
      initialItps,
      initialDocuments,
      initialTags,
      tagsError,
      documentsError,
      taskState,
      taskStateErr,
      taskStatePending,
      myInduction,
    ],
  );

  // Per-area count maps for the work-tree cards. Built once from the
  // real data the page already holds — snags + ITPs from the server,
  // evidence from live state so the photo chip ticks up after a
  // capture without a refetch. Documents are intentionally absent:
  // the document schema has no areaId, so a per-area doc count would
  // be fabricated.
  const areaCountMaps = useMemo(
    () =>
      buildAreaCountMaps({
        snags: initialSnags ?? [],
        itps: initialItps ?? [],
        evidence: evidenceItems,
      }),
    [initialSnags, initialItps, evidenceItems],
  );

  // id→name for this job's areas, so a capture's "Target" line can show the
  // area name rather than a raw id. Built from the same flattened areas the
  // work tree uses — no new data source.
  const areaNames = useMemo(
    () => Object.fromEntries(flatAreas.map((a) => [a.id, a.name] as const)),
    [flatAreas],
  );

  // ── Rooms derivations (phil_job_rooms — the #133 badge instrumentation) ──
  // Computed ONLY in rooms mode; every count is derived from data already on
  // this page (attention signals, observation blockers over the canonical
  // index, compiled proof requirements + links) — never invented (P7). These
  // are the live tab-bar badges: Now = needs-you, Work = blocked, Proof =
  // proof owed, so critical state stays visible from every room.
  const roomAttention = useMemo(
    () =>
      rooms
        ? deriveAttention({
            job,
            snags: initialSnags ?? [],
            itps: initialItps ?? [],
            viewerId: viewer?.id ?? null,
            inductionDone: Boolean(myInduction),
          })
        : { items: [], total: 0 },
    [rooms, job, initialSnags, initialItps, viewer, myInduction],
  );
  const roomBlocked = useMemo(
    () => (rooms ? blockedTasks(canonicalTasks, jobTaskBlockers) : []),
    [rooms, canonicalTasks, jobTaskBlockers],
  );
  const roomOwedProof = useMemo(
    () => (rooms ? owedProofItems(workPackages ?? [], evidenceLinks) : []),
    [rooms, workPackages, evidenceLinks],
  );
  const roomWorkCounts = useMemo(
    () => jobWorkCounts(canonicalTasks, roomBlocked),
    [canonicalTasks, roomBlocked],
  );
  const roomBlockedByArea = useMemo(() => blockedCountByArea(roomBlocked), [roomBlocked]);
  const roomOwedByArea = useMemo(() => owedProofCountByArea(roomOwedProof), [roomOwedProof]);

  // Selecting a room (or re-selecting the active one) lands on that room's
  // root — sub-screens pop, and the seq remounts the room content at its top.
  const handleSelectRoom = useCallback((next: PhilJobRoom) => {
    setRoom(next);
    setRoomAreaOpen(false);
    setRoomResetSeq((s) => s + 1);
  }, []);

  // Open an area INSIDE the rooms flow (Work → Area). Same selection + sole-
  // stage sync as the flag-off selectArea, minus the long-page scroll.
  const openRoomArea = useCallback(
    (areaId: string) => {
      setSelectedAreaId(areaId);
      const fullArea = flatAreas.find((a) => a.id === areaId) ?? null;
      if (fullArea) {
        const only = soleStage(areaStageAvailability(job, fullArea));
        if (only) setStage(only);
      }
      setRoom("work");
      setRoomAreaOpen(true);
      setRoomResetSeq((s) => s + 1);
    },
    [flatAreas, job],
  );
  const closeRoomArea = useCallback(() => setRoomAreaOpen(false), []);

  // Register the in-job bar binding while rooms are active; cleared on
  // unmount so the global sharpened bar returns the moment the job is left.
  const setRoomsBar = usePhilJobRoomsBarRegistration();
  useEffect(() => {
    if (!rooms) return;
    setRoomsBar({
      active: room,
      badges: {
        now: roomAttention.total,
        work: roomWorkCounts.blocked,
        proof: roomOwedProof.length,
      },
      onSelect: handleSelectRoom,
    });
  }, [
    rooms,
    room,
    roomAttention.total,
    roomWorkCounts.blocked,
    roomOwedProof.length,
    handleSelectRoom,
    setRoomsBar,
  ]);
  useEffect(() => () => setRoomsBar(null), [setRoomsBar]);

  // Rooms capture entries — all EXISTING paths, nothing new: Photo = the job
  // CaptureSheet (same call as the flag-off "Capture evidence" button); Note /
  // Issue = the global launcher preset to its existing worker options.
  const openJobCapture = useCallback(() => {
    setCaptureBanner(null);
    setCaptureOpen(true);
  }, []);
  const captureNote = useCallback(
    () => openQuickCapture({ kind: "worker", optionKey: "note" }),
    [openQuickCapture],
  );
  const captureIssue = useCallback(
    () => openQuickCapture({ kind: "worker", optionKey: "defect" }),
    [openQuickCapture],
  );

  // The drill-in renders below the whole area list, so on a long list a
  // tap mid-list can leave the detail off-screen with no visible
  // feedback. Bring it into view on a user tap (only — the initial
  // default selection never calls selectArea, so the page doesn't
  // auto-scroll on load).
  const areaDetailRef = useRef<HTMLDivElement>(null);

  // Selecting an area also syncs the viewed stage when the area has a
  // single stage plan — so the drill-in, the capture sheet, and the snag
  // sheet all agree on which stage we're in. Done here, at the tap, so
  // no render-phase effect is needed. Areas with both stages leave the
  // current `stage` choice intact.
  const selectArea = useCallback(
    (area: { id: string }) => {
      setSelectedAreaId(area.id);
      const fullArea = flatAreas.find((a) => a.id === area.id) ?? null;
      if (fullArea) {
        const only = soleStage(areaStageAvailability(job, fullArea));
        if (only) setStage(only);
      }
      // Scroll after the selection-driven re-render commits. scroll-mt on
      // the wrapper keeps the header clear of the sticky PhilHeader.
      requestAnimationFrame(() => {
        areaDetailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    },
    [flatAreas, job],
  );

  // Flag a variation from a task's "stop — flag a variation first" warning
  // (#368). Reuses the EXISTING variation capture flow: open the global Capture
  // launcher preset to the "variation" worker option (the same path My Day's
  // quick tiles drive). The structured #369 estimate fields are gathered by that
  // form — this handler authors none. The `trigger` (warningId / taskRef) is
  // accepted for honesty/traceability; the launcher itself scopes the capture to
  // this job via the route.
  const handleFlagVariation = useCallback(
    (_trigger: { warningId: string; taskRef?: TaskRef }) => {
      openQuickCapture({ kind: "worker", optionKey: "variation" });
    },
    [openQuickCapture],
  );

  // Open the capture flow scoped to a specific required-proof item, routing on
  // the requirement kind: a `test_result` opens the structured test-record sheet
  // (#517); everything else opens the existing photo/note CaptureSheet. Both end
  // by linking the saved proof through the SAME linkAndApply pathway.
  const handleCaptureProof = useCallback(
    (target: {
      workPackageId: string;
      requiredEvidenceId: string;
      kind: "photo" | "test_result" | "as_built" | "certificate";
      taskId: string;
      taskRef?: TaskRef;
    }) => {
      setProofStatus((prev) => {
        const next = { ...prev };
        delete next[target.requiredEvidenceId];
        return next;
      });
      if (target.kind === "test_result") {
        setTestRecordError(null);
        setTestRecordTarget({
          workPackageId: target.workPackageId,
          requiredEvidenceId: target.requiredEvidenceId,
          ...(target.taskRef ? { taskRef: target.taskRef } : {}),
        });
        setTestRecordOpen(true);
        return;
      }
      setPendingProofLink(target);
      setCaptureOpen(true);
    },
    [],
  );

  // Submit a structured test record: POST it (server re-derives pass/fail and
  // mints the companion `test_result` evidence), then link the returned evidence
  // id through the EXISTING linkAndApply — the requirement flips to met ONLY after
  // that link route confirms (non-optimistic, the same rule photo proof uses).
  const handleSubmitTestRecord = useCallback(
    async (draft: TestRecordDraft) => {
      const target = testRecordTarget;
      if (!target || !jcRevision) return;
      setTestRecordSaving(true);
      setTestRecordError(null);

      const result = await submitTestRecord({
        jobId: job.id,
        reportType: draft.reportType,
        tester: draft.tester,
        testedAt: draft.testedAt,
        rows: draft.rows,
        ...(target.taskRef
          ? {
              areaId: target.taskRef.areaId,
              stage: target.taskRef.stage,
              taskId: target.taskRef.taskId,
            }
          : {}),
      });

      if (result.kind !== "ok") {
        setTestRecordSaving(false);
        setTestRecordError(
          result.kind === "unauthorized"
            ? "You're not allowed to save a test on this job."
            : "message" in result
              ? result.message
              : "Couldn't save the test. Try again.",
        );
        return;
      }

      // Link the minted evidence to the requirement — same pathway as photo proof.
      const req = target.requiredEvidenceId;
      setProofStatus((prev) => ({ ...prev, [req]: "saving" }));
      const applied = await linkAndApply({
        jobId: job.id,
        workPackageId: target.workPackageId,
        requiredEvidenceId: req,
        evidenceId: result.evidenceId, // the REAL minted companion evidence id
        expectedJobControlRevision: jcRevision,
        ...(target.taskRef ? { taskRef: target.taskRef } : {}),
      });
      setTestRecordSaving(false);
      if (applied.revision) setJcRevision(applied.revision);
      if (applied.link) {
        const link = applied.link;
        setEvidenceLinks((prev) => [...prev, link]);
        setProofStatus((prev) => {
          const next = { ...prev };
          delete next[req];
          return next;
        });
        // #520: a failed circuit is not a dead end. When the SERVER-derived
        // record has failed rows, keep the sheet open in its saved-result view
        // so the worker can raise the defect in one tap. A clean pass (or a
        // response without a parseable record) closes exactly as before.
        const failedRows =
          result.record?.rows.filter((r) => r.status === "fail") ?? [];
        if (result.record && failedRows.length > 0) {
          setTestRecordSaved({ recordId: result.record.id, failedRows });
          setCaptureBanner({ tone: "success", message: "Test recorded." });
          window.setTimeout(() => setCaptureBanner(null), 1500);
          return;
        }
        setTestRecordOpen(false);
        setTestRecordTarget(null);
        setCaptureBanner({ tone: "success", message: "Test recorded." });
        window.setTimeout(() => setCaptureBanner(null), 1500);
      } else if (applied.status) {
        setProofStatus((prev) => ({ ...prev, [req]: applied.status! }));
        // The numbers are saved; the link failed — keep the sheet open so the
        // worker can retry without re-entering readings.
        setTestRecordError("Test saved, but couldn't attach as proof. Try again.");
      }
    },
    [testRecordTarget, jcRevision, job.id],
  );

  // #520: the worker tapped "Report defect" on the saved-result view — close
  // the test sheet and open the EXISTING Report snag sheet pre-filled with the
  // failed readings, scoped to the requirement's area/stage where known, and
  // stamped with the testRecordId it came from.
  const handleTestRecordDefect = useCallback(
    (prefill: { title: string; description: string }) => {
      const saved = testRecordSaved;
      if (!saved) return;
      const taskRef = testRecordTarget?.taskRef;
      setTestDefectSheet({
        prefill,
        testRecordId: saved.recordId,
        context: taskRef
          ? { stage: taskRef.stage, areaId: taskRef.areaId }
          : { stage: null, areaId: null },
      });
      setTestRecordOpen(false);
      setTestRecordTarget(null);
      setTestRecordSaved(null);
    },
    [testRecordSaved, testRecordTarget],
  );

  const handleCaptured = useCallback(
    async (item: EvidenceItem) => {
      setEvidenceItems((prev) => [item, ...prev]);
      setCaptureBanner({ tone: "success", message: "Evidence captured." });
      window.setTimeout(() => setCaptureBanner(null), 1500);

      // #230: a capture the Services card requested — hand the saved item back to
      // its waiting promise so it can POST the service-location link. This is a
      // real capture (already in the strip above); it just isn't proof, so we
      // return before the proof-link path runs.
      const servicesResolver = servicesCaptureResolverRef.current;
      if (servicesResolver) {
        servicesCaptureResolverRef.current = null;
        servicesResolver(item);
        return;
      }

      // If this capture was for a specific required-proof item, link it now.
      const pending = pendingProofLink;
      setPendingProofLink(null);
      if (!pending || !jcRevision) return;

      const req = pending.requiredEvidenceId;
      setProofStatus((prev) => ({ ...prev, [req]: "saving" }));
      const applied = await linkAndApply({
        jobId: job.id,
        workPackageId: pending.workPackageId,
        requiredEvidenceId: req,
        evidenceId: item.id, // the REAL saved id, never fabricated
        expectedJobControlRevision: jcRevision,
        ...(pending.taskRef ? { taskRef: pending.taskRef } : {}),
      });
      if (applied.revision) setJcRevision(applied.revision);
      if (applied.link) {
        // Met ONLY after the link route confirmed — never optimistic.
        const link = applied.link;
        setEvidenceLinks((prev) => [...prev, link]);
        setProofStatus((prev) => {
          const next = { ...prev };
          delete next[req];
          return next;
        });
      } else if (applied.status) {
        setProofStatus((prev) => ({ ...prev, [req]: applied.status! }));
      }
    },
    [pendingProofLink, jcRevision, job.id],
  );

  const handleCaptureFailed = useCallback((message: string) => {
    setCaptureBanner({ tone: "danger", message });
    // A failed save never links proof; drop any pending target.
    setPendingProofLink(null);
    // #230: a failed capture resolves any waiting Services request with null so
    // the card stops "opening camera" and the worker can retry or save text-only.
    const servicesResolver = servicesCaptureResolverRef.current;
    if (servicesResolver) {
      servicesCaptureResolverRef.current = null;
      servicesResolver(null);
    }
  }, []);

  // #230: the Services card calls this to add a photo. Opens the SAME
  // CaptureSheet (no new upload path) and returns a promise that resolves with
  // the captured EvidenceItem — or null if the sheet is closed/cancelled or the
  // capture fails. Only one services capture is in flight at a time; a fresh
  // request resolves a stale one null first.
  const handleCapturePhotoForServices = useCallback((): Promise<EvidenceItem | null> => {
    const prior = servicesCaptureResolverRef.current;
    if (prior) {
      servicesCaptureResolverRef.current = null;
      prior(null);
    }
    return new Promise<EvidenceItem | null>((resolve) => {
      servicesCaptureResolverRef.current = resolve;
      setCaptureBanner(null);
      setPendingProofLink(null);
      setCaptureOpen(true);
    });
  }, []);

  // Submit a task's captured proof for review (#503). Non-optimistic: the review
  // is reflected ONLY after the route confirms. Keyed by taskRefKey.
  const handleSubmitForReview = useCallback(
    async (taskRef: TaskRef) => {
      if (!jcRevision) return;
      const key = taskRefKey(taskRef);
      setProofSubmitStatus((prev) => ({ ...prev, [key]: "submitting" }));
      const result = await submitProofForReview({ jobId: job.id, taskRef, expectedJobControlRevision: jcRevision });
      if (result.kind === "ok") {
        setProofReviews((prev) => [...prev.filter((r) => taskRefKey(r.taskRef) !== key), result.review]);
        setJcRevision(result.revision);
        setProofSubmitStatus((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else if (result.kind === "stale") {
        if (result.currentRevision) setJcRevision(result.currentRevision);
        setProofSubmitStatus((prev) => ({ ...prev, [key]: "stale" }));
      } else {
        setProofSubmitStatus((prev) => ({ ...prev, [key]: "error" }));
      }
    },
    [jcRevision, job.id],
  );

  // Circuit schedule (field view). Read straight off the passthrough job
  // projection — the office writes `job.circuitBoards`. Show the entry only when
  // a schedule exists (P10: an existing reference slot, not new chrome; honest —
  // no empty card on jobs without one).
  const circuitBoards = (
    job as { circuitBoards?: ReadonlyArray<{ circuits?: ReadonlyArray<{ install?: string }> }> }
  ).circuitBoards;
  const hasCircuitSchedule = (circuitBoards?.length ?? 0) > 0;

  // Site-induction card state (#332) — shared verbatim by both renders.
  const siteInduction = job.inductionRequired
    ? myInduction
      ? { state: "done" as const, completedAt: myInduction.completedAt }
      : {
          state: "required" as const,
          completedAt: null,
          onConfirm: handleConfirmInduction,
          saving: inductionSaving,
          error: inductionError,
        }
    : null;

  // The modal sheets are IDENTICAL in both modes — same components, same
  // handlers, same non-optimistic write paths (capture → evidence, structured
  // test record → proof link, defect → snag). Extracted so the rooms takeover
  // and the one-scroll page can't drift apart.
  const sheets = (
    <>
      <CaptureSheet
        open={captureOpen}
        job={job}
        initialContext={{ stage, areaId: selectedAreaId }}
        onClose={() => {
          setCaptureOpen(false);
          setPendingProofLink(null);
        }}
        onCaptured={handleCaptured}
        onFailed={handleCaptureFailed}
        onCancel={() => {
          // #230: the worker dismissed the sheet without a photo — resolve any
          // waiting Services request with null so its "Opening camera" clears.
          const servicesResolver = servicesCaptureResolverRef.current;
          if (servicesResolver) {
            servicesCaptureResolverRef.current = null;
            servicesResolver(null);
          }
        }}
      />

      <PhilTestRecordCard
        open={testRecordOpen}
        jobName={job.name}
        requirementLabel={testRecordTarget?.label}
        saving={testRecordSaving}
        errorMessage={testRecordError}
        savedResult={testRecordSaved}
        onClose={() => {
          setTestRecordOpen(false);
          setTestRecordTarget(null);
          setTestRecordError(null);
          setTestRecordSaved(null);
        }}
        onSubmit={handleSubmitTestRecord}
        onReportDefect={handleTestRecordDefect}
      />

      {/* #520: defect raised FROM a failed test result — the existing snag
          sheet, pre-filled with the real readings + origin testRecordId. */}
      <ReportSnagSheet
        open={testDefectSheet !== null}
        job={job}
        initialContext={testDefectSheet?.context ?? { stage: null, areaId: null }}
        recentEvidence={evidenceItems}
        prefill={testDefectSheet?.prefill ?? null}
        originRefs={
          testDefectSheet ? { testRecordId: testDefectSheet.testRecordId } : null
        }
        onClose={() => setTestDefectSheet(null)}
        onCreated={() => {
          setTestDefectSheet(null);
          setCaptureBanner({ tone: "success", message: "Defect reported." });
          window.setTimeout(() => setCaptureBanner(null), 1500);
        }}
        onFailed={() => {
          /* the sheet surfaces its own inline error */
        }}
      />
    </>
  );

  // ── Four-rooms takeover (phil_job_rooms — the filed #133 experiment) ─────
  // In-page rooms over the SAME state/handlers/derived data as the one-scroll
  // page below; the in-job bar is registered via philJobRoomsBar. Flag off ⇒
  // this branch never runs and the current screen renders byte-identically.
  if (rooms) {
    return (
      <>
        {taskStatePromise ? (
          <Suspense fallback={null}>
            <TaskStateHydrator
              promise={taskStatePromise}
              onResolved={handleTaskStateResolved}
            />
          </Suspense>
        ) : null}

        <PhilJobRoomsView
          job={job}
          room={room}
          roomResetSeq={roomResetSeq}
          onGoToRoom={handleSelectRoom}
          areaOpen={roomAreaOpen && selectedArea !== null}
          onOpenArea={openRoomArea}
          areaView={
            selectedArea ? (
              <PhilJobRoomArea
                jobId={job.id}
                areaId={selectedArea.id}
                areaName={selectedArea.name}
                spaceType={selectedArea.spaceType}
                stages={selectedStages}
                stage={viewedStage}
                onStageChange={setStage}
                tasks={workerTasks}
                areaSpecs={areaSpecs}
                taskStatePending={taskStatePending}
                taskStateError={taskStateErr}
                taskError={taskError}
                pendingTaskIds={pendingTaskIds}
                onToggleTask={handleToggleTask}
                taskContextById={taskContextById}
                readinessByTaskId={taskReadinessById}
                onCaptureProof={handleCaptureProof}
                onFlagVariation={handleFlagVariation}
                proofActionState={proofStatus}
                canCaptureProof={Boolean(jcRevision)}
                proofReviews={proofReviews}
                onSubmitForReview={handleSubmitForReview}
                proofSubmitStatus={proofSubmitStatus}
                canSubmitForReview={Boolean(jcRevision)}
                owedProof={roomOwedProof}
                onBack={closeRoomArea}
                onCapturePhoto={openJobCapture}
                onCaptureNote={captureNote}
                onCaptureIssue={captureIssue}
              />
            ) : null
          }
          attention={roomAttention}
          evidenceItems={evidenceItems}
          captureBanner={captureBanner}
          areaNames={areaNames}
          viewer={viewer}
          onEvidenceUpdated={(updated) =>
            setEvidenceItems((prev) =>
              prev.map((it) => (it.id === updated.id ? updated : it)),
            )
          }
          onOpenCapture={openJobCapture}
          groups={groups}
          workCounts={roomWorkCounts}
          taskStatePending={taskStatePending}
          taskStateErr={taskStateErr}
          jobComplete={jobComplete}
          rollup={taskRollup}
          blockedByArea={roomBlockedByArea}
          owedByArea={roomOwedByArea}
          areaCountMaps={areaCountMaps}
          workPackages={workPackages}
          evidenceLinks={evidenceLinks}
          snags={initialSnags ?? []}
          snagContext={{ stage, areaId: selectedAreaId }}
          owedProof={roomOwedProof}
          proofReviews={proofReviews}
          itps={initialItps ?? []}
          tags={initialTags ?? []}
          tagsError={tagsError}
          hasCircuitSchedule={hasCircuitSchedule}
          circuitBoards={circuitBoards}
          certificatesEnabled={certificatesEnabled}
          documents={initialDocuments}
          documentsError={documentsError ?? null}
          contacts={initialContacts}
          serviceLocations={initialServiceLocations}
          serviceLocationsError={serviceLocationsError ?? null}
          canWriteServiceLocations={canAddServiceLocation(viewer?.role)}
          onCapturePhotoForServices={handleCapturePhotoForServices}
          siteInduction={siteInduction}
          safetyEnabled={safetyEnabled}
        />

        {sheets}
      </>
    );
  }

  return (
    <div className="space-y-4 pb-2">
      <div className="-mt-1">
        <PhilOfflineLink
          href="/phil/jobs"
          className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← All jobs
        </PhilOfflineLink>
      </div>

      {/* Streamed task-state resolver (perf): renders nothing; when the lifted
          /api/data read resolves it seeds taskState + clears the pending skeleton.
          Behind its own <Suspense> so it never blocks the structure paint. */}
      {taskStatePromise ? (
        <Suspense fallback={null}>
          <TaskStateHydrator
            promise={taskStatePromise}
            onResolved={handleTaskStateResolved}
          />
        </Suspense>
      ) : null}

      <PhilJobHero job={job} />

      <PhilJobCommandPanel model={commandModel} />

      <PhilJobAttentionStrip
        job={job}
        snags={initialSnags ?? []}
        itps={initialItps ?? []}
        viewerId={viewer?.id ?? null}
        inductionDone={Boolean(myInduction)}
      />

      {flatAreas.length > 0 ? (
        <section
          id="phil-job-work"
          aria-labelledby="phil-job-work-h"
          className="scroll-mt-16 space-y-4"
        >
          {/* Calm completion (#427): one quiet acknowledgement near "Work to do"
              when every task on the job is really done — gated on a real, loaded
              100% (jobComplete), so a not-yet-loaded job never flashes a false
              win (P7). One success notice, no new metric/colour (P10). */}
          {jobComplete ? (
            <PhilNotice tone="success" title="Every task here is done." role="status">
              Nice work — the whole job&rsquo;s ticked off. Snags, checks and hours
              still live below if anything needs a look.
            </PhilNotice>
          ) : null}
          {groups.length > 0 ? (
            <Card>
              <CardTitle>
                <span id="phil-job-work-h">Work to do</span>
              </CardTitle>
              <CardDescription className="mt-1">
                Pick an area to drill in — its stages, tasks, and what&rsquo;s
                outstanding.
              </CardDescription>
              <div className="mt-3 space-y-4">
                {groups.map((group) => {
                  const areas = group.areas ?? [];
                  if (areas.length === 0) return null;
                  return (
                    <div key={group.id}>
                      <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                        {group.name}
                      </p>
                      <ul
                        className="mt-2 grid gap-2"
                        role="listbox"
                        aria-label={`Areas in ${group.name}`}
                      >
                        {areas.map((area) => (
                          <li key={area.id}>
                            <PhilJobAreaCard
                              name={area.name}
                              spaceType={area.spaceType}
                              active={area.id === selectedAreaId}
                              stages={areaStageAvailability(job, area)}
                              counts={countsForArea(areaCountMaps, area.id)}
                              onSelect={() => selectArea(area)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : (
            <Card>
              <CardTitle>
                <span id="phil-job-work-h">Work to do</span>
              </CardTitle>
              <CardDescription className="mt-2">
                No areas configured for this job yet. Ask your PM or check the
                legacy Job Builder.
              </CardDescription>
            </Card>
          )}

          {selectedArea ? (
            <div ref={areaDetailRef} className="scroll-mt-16 space-y-3">
              {taskError ? (
                <PhilNotice
                  tone="danger"
                  title="Couldn’t update task"
                  role="alert"
                >
                  {taskError}
                </PhilNotice>
              ) : null}
              {taskStateErr ? (
                <PhilNotice
                  tone="warning"
                  title="Couldn’t load task progress"
                  role="status"
                >
                  Task rows may show as to do until you refresh. Saved changes
                  will still update after the server confirms them.
                </PhilNotice>
              ) : null}
              {taskStatePending ? (
                // Task state is still streaming (perf): show a skeleton of the
                // drill-in rather than the task rows, so a DONE task is never
                // briefly shown as "to do". Replaced by the real rows the instant
                // the streamed state lands. Heights mirror the real drill-in to
                // keep layout shift minimal.
                <div
                  className="space-y-3 rounded-card border border-border bg-surface-raised p-4"
                  aria-busy="true"
                  aria-label="Loading task progress"
                >
                  <PhilSkeleton className="h-9 w-full" />
                  <PhilSkeleton className="h-4 w-24" />
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <PhilSkeleton key={i} className="h-[52px] w-full" />
                    ))}
                  </div>
                </div>
              ) : (
                <PhilJobAreaDetail
                  jobId={job.id}
                  areaName={selectedArea.name}
                  spaceType={selectedArea.spaceType}
                  stages={selectedStages}
                  stage={viewedStage}
                  areaSpecs={areaSpecs}
                  tasks={workerTasks}
                  counts={countsForArea(areaCountMaps, selectedArea.id)}
                  onStageChange={setStage}
                  onToggleTask={handleToggleTask}
                  pendingTaskIds={pendingTaskIds}
                  taskContextById={taskContextById}
                  readinessByTaskId={taskReadinessById}
                  onCaptureProof={handleCaptureProof}
                  onFlagVariation={handleFlagVariation}
                  proofActionState={proofStatus}
                  canCaptureProof={Boolean(jcRevision)}
                  proofReviews={proofReviews}
                  onSubmitForReview={handleSubmitForReview}
                  proofSubmitStatus={proofSubmitStatus}
                  canSubmitForReview={Boolean(jcRevision)}
                />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section
        id="phil-job-capture"
        aria-labelledby="phil-job-capture-h"
        className="scroll-mt-16 space-y-4"
      >
        <Card>
          <CardTitle>
            <span id="phil-job-capture-h">Capture evidence</span>
          </CardTitle>
          <CardDescription className="mt-1">
            Take a photo (with an optional note) attached to this job. The selected
            stage and area carry through to the capture sheet.
          </CardDescription>
          <div className="mt-3">
            <PhilActionButton
              size="lg"
              onClick={() => {
                setCaptureBanner(null);
                setCaptureOpen(true);
              }}
            >
              <Camera aria-hidden="true" className="h-5 w-5" />
              Capture evidence
            </PhilActionButton>
          </div>
        </Card>

        <TodaysCapturesStrip
          items={evidenceItems}
          banner={captureBanner}
          areaNames={areaNames}
          jobId={job.id}
          viewerId={viewer?.id}
          onItemUpdated={(updated) =>
            setEvidenceItems((prev) =>
              prev.map((it) => (it.id === updated.id ? updated : it))
            )
          }
        />
      </section>

      {/* Snags — flag-gated (`snags`, lean reset): the section mounts only
          while the feature is live (its API 404s when dark). */}
      {viewer && snagsEnabled ? (
        <section
          id="phil-job-snags"
          aria-label="Snags"
          className="scroll-mt-16"
        >
          <JobSnagsPanel
            job={job}
            initialSnags={initialSnags}
            context={{ stage, areaId: selectedAreaId }}
            recentEvidence={evidenceItems}
            viewer={viewer}
          />
        </section>
      ) : null}

      {/* Job-interface sections: header → command → attention → site →
          areas/work → capture → Snags → ITPs → Plans → Documents.

          ITPs — flag-gated (`itp`, lean reset). JobDocumentsPanel is LIVE
          (E2, read-only; ungated /api/plans read). */}
      {itpEnabled ? (
        <section id="phil-job-itps" aria-label="ITPs" className="scroll-mt-16">
          <JobItpPanel job={job} initialItps={initialItps} />
        </section>
      ) : null}

      {/* Simple ITP builder (#912, lean-reset step 6) — link-out only, the
          builder lives on its own route. Independent of the heavy `itp`
          system above; no trace while the flag is dark. */}
      {itpSimpleEnabled ? (
        <section id="phil-job-itp-reports" aria-label="ITP reports" className="scroll-mt-16">
          <Card>
            <CardTitle>ITPs</CardTitle>
            <CardDescription className="mt-1">
              Build an inspection report as you walk — name areas, drop photos
              in, make the PDF.
            </CardDescription>
            <div className="mt-3">
              <PhilOfflineLink
                href={`/phil/jobs/${encodeURIComponent(job.id)}/itp-reports`}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <ClipboardList aria-hidden="true" className="h-5 w-5" />
                Open ITPs
              </PhilOfflineLink>
            </div>
          </Card>
        </section>
      ) : null}

      {moduleEnabled(job, "tags") ? (
        <section id="phil-job-tags" aria-label="Test and tag" className="scroll-mt-16">
          <JobTagsPanel jobId={job.id} initialTags={initialTags ?? []} loadError={tagsError} />
        </section>
      ) : null}

      {moduleEnabled(job, "plans") ? (
        <section id="phil-job-plans" aria-label="Plans" className="scroll-mt-16">
          <Card>
            <CardTitle>Plans</CardTitle>
            <CardDescription className="mt-1">
              Open the current drawings for this job in the in-app viewer — zoom,
              rotate and page through. Read-only.
            </CardDescription>
            <div className="mt-3">
              <PhilOfflineLink
                href={`/phil/jobs/${encodeURIComponent(job.id)}/plans`}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <MapIcon aria-hidden="true" className="h-5 w-5" />
                Open plan viewer
              </PhilOfflineLink>
            </div>
          </Card>
        </section>
      ) : null}

      {/* Photos (#242) — the read-only "Job Bible" gallery: browse every photo
          on the job. Hidden-until-real — linked only when there's at least one
          capture the worker can already see (the page's own evidence list), so
          the field never lands on an empty gallery. Reference-zone slot beside
          Plans (P10); capture stays on the job home above (browse ≠ capture). */}
      {evidenceItems.length > 0 ? (
        <section id="phil-job-photos" aria-label="Photos" className="scroll-mt-16">
          <Card>
            <CardTitle>Photos</CardTitle>
            <CardDescription className="mt-1">
              Browse every photo on this job in one place — date-grouped and
              filterable. Read-only.
            </CardDescription>
            <div className="mt-3">
              <PhilOfflineLink
                href={`/phil/jobs/${encodeURIComponent(job.id)}/photos`}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <Images aria-hidden="true" className="h-5 w-5" />
                Open photo gallery
              </PhilOfflineLink>
            </div>
          </Card>
        </section>
      ) : null}

      {/* Circuit schedule — the field view of the office's distribution-board
          schedule. Only shown when the office has started one (honest empty);
          opens the boards → ways surface where the worker marks each way to do →
          installed → tested. Reference-zone slot beside Plans (P10). */}
      {hasCircuitSchedule ? (
        <section id="phil-job-circuit-schedule" aria-label="Circuit schedule" className="scroll-mt-16">
          <Card>
            <CardTitle>Circuit schedule</CardTitle>
            <CardDescription className="mt-1">
              Boards and ways for this job — mark each way as you go: to do, installed,
              tested. {scheduleSummaryLine(circuitBoards)}.
            </CardDescription>
            <div className="mt-3">
              <PhilOfflineLink
                href={`/phil/jobs/${encodeURIComponent(job.id)}/circuit-schedule`}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <Zap aria-hidden="true" className="h-5 w-5" />
                Open circuit schedule
              </PhilOfflineLink>
            </div>
          </Card>
        </section>
      ) : null}

      {/* #219: Safety — SWMS/SDS the worker acknowledges. Hidden-until-real
          (renders nothing until docs load); mounted only when the safety_docs
          flag is on. Reference-zone slot beside Plans/Circuit (P10). */}
      {safetyEnabled ? <PhilSafetyHomeSection jobId={job.id} /> : null}

      {/* #231: Certificates — read-only compliance/commissioning records.
          Hidden-until-real; mounted only when certificates_register is on. */}
      {certificatesEnabled ? <PhilCertificatesHomeSection jobId={job.id} /> : null}

      {/* Documents & specs — JobDocumentsPanel owns its own
          #phil-job-documents section and renders nothing when the job has no
          documents and no fetch error (an empty job shows no card). A
          superseded-only job and fetch errors still render. */}
      <JobDocumentsPanel
        initialDocuments={initialDocuments}
        fetchError={documentsError ?? null}
      />

      {/* Site details — reference info (address / access / parking / safety /
          induction). Demoted to the bottom "reference" zone so the active work
          loop (Work + Capture) leads the page. Keeps #phil-job-site so the
          attention strip's induction item still scrolls here. */}
      <PhilJobSiteCard job={job} induction={siteInduction} />

      {/* Services on site (#230) — where the pit / board / meter / temp supply
          are, with optional photos, so anyone can find them. Reference-zone slot
          beside Site details + Who to call. Collapsible; renders nothing when the
          job has no records and the viewer can't add (P10). Photos are served
          from the denormalised URLs (worker B sees worker A's board photo); the
          "Add a photo" path reuses the existing CaptureSheet. */}
      <PhilJobServicesCard
        jobId={job.id}
        initialRecords={initialServiceLocations}
        loadError={serviceLocationsError ?? null}
        canWrite={canAddServiceLocation(viewer?.role)}
        onCapturePhoto={handleCapturePhotoForServices}
      />

      {/* Who to call (#189) — categorised job contacts with tap-to-call.
          Renders nothing when the office hasn't added any. */}
      {initialContacts && initialContacts.length > 0 ? (
        <section id="phil-job-contacts" aria-label="Who to call" className="scroll-mt-16">
          <PhilJobContactsCard contacts={initialContacts} />
        </section>
      ) : null}

      {/* On site today (#426) — who else has logged time on this job today, so
          the worker knows who's around. Client-fetched (reuses the existing
          /api/time-entries-on-site endpoint); degrades on its own. */}
      <section id="phil-job-crew" aria-label="On site today" className="scroll-mt-16">
        <PhilJobCrewCard jobId={job.id} viewerId={viewer?.id ?? null} />
      </section>

      {sheets}
    </div>
  );
}

/**
 * Tiny leaf that resolves the STREAMED task-state promise (perf — flag-on) and
 * seeds it into PhilJobDetail's state exactly once. `use()` suspends this leaf
 * until the lifted /api/data read resolves (handled by the parent
 * <Suspense fallback={null}>), so the structure paints without waiting and this
 * fires on the client once the value lands. Renders nothing.
 */
function TaskStateHydrator({
  promise,
  onResolved,
}: {
  promise: Promise<{ state: JobTaskState; error: string | null }>;
  onResolved: (resolved: { state: JobTaskState; error: string | null }) => void;
}) {
  const resolved = use(promise);
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    onResolved(resolved);
  }, [resolved, onResolved]);
  return null;
}
