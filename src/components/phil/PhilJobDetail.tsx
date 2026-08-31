"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { PhilSkeleton } from "./ui/PhilSkeleton";
import { Camera, ClipboardList, Images } from "lucide-react";
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
import { buildPhilJobCommandModel } from "@/domains/phil/job-command-model";
import { philJobCommandInputFromJobData } from "@/domains/phil/job-command-input";
import { philWrite } from "@/domains/phil/write-client";
import { confirmInduction, type InductionRecord } from "@/domains/jobs/induction";
import { JobTagsPanel } from "./JobTagsPanel";
import { buildAreaTaskContext } from "./philTaskContext";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import { PhilJobServicesCard } from "./PhilJobServicesCard";
import { canAddServiceLocation } from "@/domains/services-locations/permissions";
import type { JobContact } from "@/domains/contacts/schema";
import type { ServiceLocationRecord } from "@/domains/services-locations/types";
import type { TagItem } from "@/domains/tags/schema";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Document } from "@/domains/documents/types";
import { filterSpecsByArea, isCurrent } from "@/domains/documents/format";
import { CaptureSheet } from "./CaptureSheet";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
import { PhilJobCrewCard } from "./PhilJobCrewCard";
import { PhilFixJobName } from "./PhilFixJobName";
import { PhilJobHero } from "./PhilJobHero";
import { PhilJobCommandPanel } from "./PhilJobCommandPanel";
import { PhilJobAttentionStrip } from "./PhilJobAttentionStrip";
import { PhilJobAreaCard } from "./PhilJobAreaCard";
import { PhilJobAreaDetail } from "./PhilJobAreaDetail";
import { readJobResume, writeJobResume } from "./jobResume";
import {
  areaStageAvailability,
  buildAreaCountMaps,
  countsForArea,
  soleStage,
} from "./philJobWorkTree";
import { deriveAttention } from "./PhilJobAttention";
import type { PhilJobRoom } from "./philJobRooms";
import { usePhilJobRoomsBarRegistration } from "./philJobRoomsBar";
import { PhilJobRoomsView } from "./PhilJobRoomsView";
import { PhilJobRoomArea } from "./PhilJobRoomArea";

interface Props {
  job: Job;
  /** Initial evidence list fetched server-side (server filters to own
   *  captures for tradie; admin/LH see all). May be empty on load. */
  initialEvidence?: ReadonlyArray<EvidenceItem>;
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
  /** Current viewer — id + role drive the crew/capture attribution. */
  viewer?: { id: string; role: string };
  /** When set (and changing), auto-opens the capture sheet. Driven by
   *  the `?capture=<token>` deep link the global Capture launcher
   *  (PhilTabBar FAB) pushes, so a worker can start a capture from
   *  anywhere in Phil in one tap. A fresh token re-opens on repeat taps. */
  autoCaptureToken?: string | null;
  /** `itp_simple` flag (#912): mount the simple ITP builder link-out only when
   *  live — the /phil/jobs/[jobId]/itp-reports route + API 404 while dark. */
  itpSimpleEnabled?: boolean;
  /** #915: the Photos gallery card is DATA-driven — without the flag it would
   *  link to a flag-gated 404 route. */
  photosGalleryEnabled?: boolean;
  /**
   * phil_job_rooms (dark — the filed #133 experiment): render this job as the
   * FOUR ROOMS takeover (Now · Work · [Capture] · Proof · Site with the in-job
   * bottom bar) instead of the one-scroll page. Resolved SERVER-SIDE via
   * philSharpenedFlags (which enforces jobRooms ⇒ sharpened) and passed as a
   * boolean. False/absent = the current job screen, byte-identical. The rooms
   * are in-page client state on this same route — no new URLs.
   */
  rooms?: boolean;
  /** Owner ruling 2026-08-31 — whoever can add a job can fix its name. True
   *  when the viewer could have created this job (phil_sharpened resolved
   *  server-side, same gate as "+ New job"); renders the bottom-of-page
   *  "Wrong job name? Fix it" row. False/absent = no trace (dark-safe). */
  canFixName?: boolean;
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
 *   4. <PhilJobAttentionStrip/> — strict, max 3, real signals
 *      (induction). Hidden when nothing qualifies. Attention stays here,
 *      not in the command panel, so the two never duplicate.
 *   5. "Work to do" (#phil-job-work) — stage chooser + area picker +
 *      effective task list + per-task toggle. The active work, led first.
 *   6. Capture block (#phil-job-capture) — primary CTA + today's
 *      capture strip. ("Capture evidence" — kept verbatim; smoke/e2e
 *      match this button + the CaptureSheet dialog name.)
 *   8b. Simple ITP builder link-out (#phil-job-itp-reports) — flag-gated
 *      (`itp_simple`, #912); a Card link to /itp-reports, no inline panel.
 *   9. Plans (#phil-job-plans) — in-app drawing viewer link.
 *  10. Documents (#phil-job-documents) — JobDocumentsPanel (live, E2
 *      read-only — "Site files"; backed by the ungated /api/plans read).
 *  11. <PhilJobSiteCard/> "Site details" (#phil-job-site) — reference info
 *      (address / contact / access / parking / safety / induction),
 *      collapsible. Demoted to the bottom reference zone so the active work
 *      loop leads; keeps #phil-job-site for the induction attention link.
 *  12. <PhilFixJobName/> — "Wrong job name? Fix it" quiet row, dead last
 *      (owner ruling 2026-08-31: whoever can add a job can fix its name).
 *      Gated by canFixName (the page's phil_sharpened resolution).
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
  autoCaptureToken,
  itpSimpleEnabled = false,
  photosGalleryEnabled = false,
  rooms = false,
  canFixName = false,
}: Props) {
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

  // Per-task readiness (#482 model) for the viewed area+stage, keyed by task id —
  // the same key the rows + scope-context use. The row shows a "Blocked — reason"
  // line only when a task resolves to `blocked`. Blockers come from real
  // `deriveTaskReadiness` matches blockers by canonical task id. With no
  // blocker source on this screen the list is empty and every not-complete
  // task is `ready` — zero visual change.
  const taskReadinessById = useMemo(
    () =>
      selectedArea
        ? philTaskReadinessByTemplateId({
            canonicalTasks,
            areaId: selectedArea.id,
            stage: viewedStage,
            blockers: [],
          })
        : undefined,
    [canonicalTasks, selectedArea, viewedStage],
  );

  // Per-task scope context (#368) for the viewed area+stage. With no compiled
  // artifact on this screen the adapter returns an empty map — every task
  // renders exactly as it does today (zero regression).
  const taskContextById = useMemo(
    () =>
      selectedArea
        ? buildAreaTaskContext({
            areaId: selectedArea.id,
            stage: viewedStage,
            taskIds: workerTasks.map((t) => t.id),
          })
        : undefined,
    [selectedArea, viewedStage, workerTasks],
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
          // #916 strip: plans + tasks left the page — their quick actions
          // must not anchor to sections that no longer exist.
          features: { plans: false, tasks: false },
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

  // Per-area count maps for the work-tree cards. Built once from the real
  // data the page already holds — evidence from live state so the photo chip
  // ticks up after a capture without a refetch. Documents are intentionally
  // absent: the document schema has no areaId, so a per-area doc count would
  // be fabricated.
  const areaCountMaps = useMemo(
    () => buildAreaCountMaps({ evidence: evidenceItems }),
    [evidenceItems],
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
        ? deriveAttention({ job, inductionDone: Boolean(myInduction) })
        : { items: [], total: 0 },
    [rooms, job, myInduction],
  );

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
      badges: { now: roomAttention.total, work: 0, proof: 0 },
      onSelect: handleSelectRoom,
    });
  }, [rooms, room, roomAttention.total, handleSelectRoom, setRoomsBar]);
  useEffect(() => () => setRoomsBar(null), [setRoomsBar]);

  // Rooms capture entry — the EXISTING path: the job CaptureSheet (same call
  // as the flag-off "Capture evidence" button).
  const openJobCapture = useCallback(() => {
    setCaptureBanner(null);
    setCaptureOpen(true);
  }, []);

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

    },
    [],
  );

  const handleCaptureFailed = useCallback((message: string) => {
    setCaptureBanner({ tone: "danger", message });
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
      setCaptureOpen(true);
    });
  }, []);

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

  // The modal sheets are IDENTICAL in both modes — same component, same
  // handlers, same non-optimistic write path (capture → evidence). Extracted
  // so the rooms takeover and the one-scroll page can't drift apart.
  const sheets = (
    <>
      <CaptureSheet
        open={captureOpen}
        job={job}
        initialContext={{ stage, areaId: selectedAreaId }}
        onClose={() => setCaptureOpen(false)}
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

    </>
  );

  // ── Four-rooms takeover (phil_job_rooms — the filed #133 experiment) ─────
  // In-page rooms over the SAME state/handlers/derived data as the one-scroll
  // page below; the in-job bar is registered via philJobRoomsBar. Flag off ⇒
  // this branch never runs and the current screen renders byte-identically.
  // Lean reset step 5 (#916): the four-rooms takeover left with the
  // work-to-do machinery; restore from git if structure returns.

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

      <PhilJobHero job={job} />

      <PhilJobCommandPanel model={commandModel} />

      <PhilJobAttentionStrip job={job} inductionDone={Boolean(myInduction)} />

      {/* Lean reset step 5 (#916): the work-to-do machinery (stage groups,
          area picker, task lists, streamed task state) left the page — lean
          jobs deliberately have no structure. Restore from git if reversed. */}
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
            Take a photo (with an optional note) attached to this job.
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

      {/* Plans card removed by the lean reset (#916 call 1): drawings left
          the job pages; the /plans route stays URL-reachable, unlinked. */}
      {/* Photos (#242) — the read-only "Job Bible" gallery: browse every photo
          on the job. Hidden-until-real — linked only when there's at least one
          capture the worker can already see (the page's own evidence list), so
          the field never lands on an empty gallery. Reference-zone slot beside
          Plans (P10); capture stays on the job home above (browse ≠ capture). */}
      {photosGalleryEnabled && evidenceItems.length > 0 ? (
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

      {/* Site details — reference info (address / access / parking / safety /
          induction). Demoted to the bottom "reference" zone so the active work
          loop (Work + Capture) leads the page. Keeps #phil-job-site so the
          attention strip's induction item still scrolls here. */}
      <PhilJobSiteCard job={job} induction={siteInduction} />

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

      {/* Owner ruling 2026-08-31 — whoever can add a job can fix its name.
          The rare corrective action buys the CHEAPEST slot on the page: one
          quiet row at the very bottom of the reference zone (P10); the hero
          keeps its "no icons next to the name" rule. Gated by the same
          phil_sharpened resolution as "+ New job" — no trace while dark. */}
      {canFixName ? <PhilFixJobName job={job} /> : null}

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
