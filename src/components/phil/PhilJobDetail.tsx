"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Map as MapIcon } from "lucide-react";
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
import {
  philTaskReadinessByTemplateId,
  workerTasksFromCanonicalIndex,
} from "@/domains/jobs/phil-task-projection";
import { taskBlockersFromObservations } from "@/domains/observations/task-blockers";
import { buildPhilJobCommandModel } from "@/domains/phil/job-command-model";
import { philJobCommandInputFromJobData } from "@/domains/phil/job-command-input";
import { confirmInduction, type InductionRecord } from "@/domains/jobs/induction";
import { JobTagsPanel } from "./JobTagsPanel";
import { buildAreaTaskContext } from "./philTaskContext";
import { linkAndApply, type ProofActionStatus } from "./jobControlEvidenceLinkClient";
import {
  submitProofForReview,
  type ProofSubmitStatus,
} from "./jobControlProofReviewClient";
import { PhilJobContactsCard } from "./PhilJobContactsCard";
import { taskRefKey } from "@/domains/job-control/spine";
import type { JobContact } from "@/domains/contacts/schema";
import type { TagItem } from "@/domains/tags/schema";
import type { Job, JobStage } from "@/domains/jobs/types";
import type { EvidenceLink, ProofReview, TaskRef, WorkPackage } from "@/domains/job-control/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { Document } from "@/domains/documents/types";
import { CaptureSheet } from "./CaptureSheet";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import { JobSnagsPanel } from "./JobSnagsPanel";
import { JobItpPanel } from "./JobItpPanel";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { PhilJobDeferredNote } from "./PhilJobDeferredNote";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
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
 *   7. Snags (#phil-job-snags) — JobSnagsPanel (live).
 *   8. ITPs (#phil-job-itps) — JobItpPanel (live, Phase E1b).
 *   9. Plans (#phil-job-plans) — in-app drawing viewer link.
 *  10. Documents (#phil-job-documents) — JobDocumentsPanel (live, E2
 *      read-only — "Site files").
 *  11. <PhilJobSiteCard/> "Site details" (#phil-job-site) — reference info
 *      (address / contact / access / parking / safety / induction),
 *      collapsible. Demoted to the bottom reference zone so the active work
 *      loop leads; keeps #phil-job-site for the induction attention link.
 *  12. Not connected yet (#phil-job-more) — one concise PhilJobDeferredNote
 *      for the deferred Materials + History surfaces.
 *
 * Section ORDER is the worker flow: do the work → capture proof → handle
 * problems/checks → references (plans/docs) → site details → what's not wired.
 * Deferred surfaces are an honest one-line note — no fake counts, no fake
 * buttons, no full "under construction" cards.
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
  initialMyInduction,
  initialTaskState,
  taskStateError,
  viewer,
  workPackages,
  evidenceLinks: initialEvidenceLinks,
  proofReviews: initialProofReviews,
  jobControlRevision,
  autoCaptureToken,
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

  const [captureOpen, setCaptureOpen] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<ReadonlyArray<EvidenceItem>>(
    initialEvidence ?? []
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

  // Worker-visible task state (areaId → stage → taskId → state). Seeded from
  // the server-loaded data blob; only ever advanced by a CONFIRMED
  // /api/task-toggle response (never optimistically), so a failed write never
  // shows a task as done.
  const [taskState, setTaskState] = useState<JobTaskState>(initialTaskState ?? {});
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [taskError, setTaskError] = useState<string | null>(null);

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
    }
  }, [job.id, flatAreas]);

  useEffect(() => {
    if (!selectedAreaId) return;
    writeJobResume(job.id, { areaId: selectedAreaId, stage: viewedStage });
  }, [job.id, selectedAreaId, viewedStage]);

  // Canonical task index (#480) for this job — rebuilt only when the plan or the
  // recorded state changes. This is now the SOURCE for the worker task rows
  // (#484): the platform treats a task as a job-level instance keyed by
  // (areaId, stage, taskId) while Phil keeps its area-first view.
  const canonicalTasks = useMemo(
    () => buildCanonicalTaskIndex({ job, taskState }),
    [job, taskState],
  );

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
      try {
        const res = await fetch(
          `/api/task-toggle?jobId=${encodeURIComponent(job.id)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              areaId,
              stage: stageForWrite,
              taskId,
              state: next,
            }),
          },
        );
        if (!res.ok) {
          let message = `Couldn't save that change (server returned ${res.status}).`;
          try {
            const body = await res.json();
            if (body && typeof body.error === "string") message = body.error;
          } catch {
            /* keep the default message */
          }
          throw new Error(message);
        }
        const confirmed = parseTaskToggleResult(await res.json().catch(() => null));
        if (!confirmed) {
          throw new Error("Unexpected task update response.");
        }
        setTaskState((prev) =>
          applyTaskState(prev, areaId, stageForWrite, taskId, confirmed),
        );
      } catch (err) {
        setTaskError(
          err instanceof Error
            ? err.message
            : "Couldn't save that change. Check your signal and try again.",
        );
      } finally {
        setPendingTaskIds((prev) => {
          const set = new Set(prev);
          set.delete(taskId);
          return set;
        });
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
          taskState: taskStateError ? undefined : taskState,
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
      taskStateError,
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

  // Open the existing capture sheet scoped to a specific required-proof item.
  // The captured evidence is then auto-linked in handleCaptured.
  const handleCaptureProof = useCallback(
    (target: { workPackageId: string; requiredEvidenceId: string; taskId: string; taskRef?: TaskRef }) => {
      setPendingProofLink(target);
      setProofStatus((prev) => {
        const next = { ...prev };
        delete next[target.requiredEvidenceId];
        return next;
      });
      setCaptureOpen(true);
    },
    [],
  );

  const handleCaptured = useCallback(
    async (item: EvidenceItem) => {
      setEvidenceItems((prev) => [item, ...prev]);
      setCaptureBanner({ tone: "success", message: "Evidence captured." });
      window.setTimeout(() => setCaptureBanner(null), 1500);

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

  return (
    <div className="space-y-4 pb-2">
      <div className="-mt-1">
        <Link
          href="/phil/jobs"
          className="inline-flex items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← All jobs
        </Link>
      </div>

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
              {taskStateError ? (
                <PhilNotice
                  tone="warning"
                  title="Couldn’t load task progress"
                  role="status"
                >
                  Task rows may show as to do until you refresh. Saved changes
                  will still update after the server confirms them.
                </PhilNotice>
              ) : null}
              <PhilJobAreaDetail
                areaName={selectedArea.name}
                spaceType={selectedArea.spaceType}
                stages={selectedStages}
                stage={viewedStage}
                tasks={workerTasks}
                counts={countsForArea(areaCountMaps, selectedArea.id)}
                onStageChange={setStage}
                onToggleTask={handleToggleTask}
                pendingTaskIds={pendingTaskIds}
                taskContextById={taskContextById}
                readinessByTaskId={taskReadinessById}
                onCaptureProof={handleCaptureProof}
                proofActionState={proofStatus}
                canCaptureProof={Boolean(jcRevision)}
                proofReviews={proofReviews}
                onSubmitForReview={handleSubmitForReview}
                proofSubmitStatus={proofSubmitStatus}
                canSubmitForReview={Boolean(jcRevision)}
              />
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
        />
      </section>

      {viewer ? (
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
          areas/work → capture → Snags → ITPs → Plans → Documents, then one
          honest "not connected yet" note for the deferred surfaces.

          JobItpPanel is LIVE (E1b). JobDocumentsPanel is LIVE (E2, read-only).
          Materials + History are deferred — a single PhilJobDeferredNote, not
          two full UC cards. */}
      <section id="phil-job-itps" aria-label="ITPs" className="scroll-mt-16">
        <JobItpPanel job={job} initialItps={initialItps} />
      </section>

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
              <Link
                href={`/phil/jobs/${encodeURIComponent(job.id)}/plans`}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <MapIcon aria-hidden="true" className="h-5 w-5" />
                Open plan viewer
              </Link>
            </div>
          </Card>
        </section>
      ) : null}

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
      <PhilJobSiteCard
        job={job}
        induction={
          job.inductionRequired
            ? myInduction
              ? { state: "done", completedAt: myInduction.completedAt }
              : {
                  state: "required",
                  completedAt: null,
                  onConfirm: handleConfirmInduction,
                  saving: inductionSaving,
                  error: inductionError,
                }
            : null
        }
      />

      {/* Who to call (#189) — categorised job contacts with tap-to-call.
          Renders nothing when the office hasn't added any. */}
      {initialContacts && initialContacts.length > 0 ? (
        <section id="phil-job-contacts" aria-label="Who to call" className="scroll-mt-16">
          <PhilJobContactsCard contacts={initialContacts} />
        </section>
      ) : null}

      {/* Secondary — deferred surfaces. The Materials + History UC stubs used
          to be two full cards here; consolidated into one honest, low-emphasis
          "not connected yet" note so placeholders don't dominate the scroll. */}
      <section
        id="phil-job-more"
        aria-label="Not connected yet"
        className="scroll-mt-16"
      >
        <PhilJobDeferredNote />
      </section>

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
      />
    </div>
  );
}
