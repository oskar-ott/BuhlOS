"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileText,
  HardHat,
  Info,
  ListChecks,
  Lock,
  Package,
  PanelRight,
  Plus,
  Save,
  Send,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ScopeOfWorkSection } from "./ScopeOfWorkSection";
import { ScopeReconciliationStatus } from "./ScopeReconciliationStatus";
import { ClientContractSection } from "./ClientContractSection";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  captureStructurePreset,
  getJobForEdit,
  listStructurePresets,
  publishJob,
  unpublishJob,
  updateJob,
} from "@/domains/jobs/client";
import type { GenerationSummary } from "@/domains/jobs/task-rules";
import {
  autoNumberedNames,
  instantiatePreset,
  type StructurePreset,
} from "@/domains/jobs/structure-presets";
import { Modal } from "@/components/ui/Modal";
import {
  buildBuilderReadiness,
  buildPhilPreview,
  buildUpdatePayload,
  canPublish,
  isVisibleToField,
  moduleEnabled,
  projectArchivedStructure,
  publishState,
  summariseStructure,
  validateForPublish,
  type AreaRowForm,
  type ArchivedStructure,
  type JobBuilderForm,
  type ReadinessIssue,
  type TaskRowForm,
} from "@/domains/jobs/builder";
import { JobBuilderCockpit, type CockpitNavGroup, type CockpitSectionStatus } from "./JobBuilderCockpit";
import { Inspector, type InspectorRow } from "./Inspector";
import { ReviewQueue, type ReviewClause } from "./ReviewQueue";
import { JobAssignmentPanel } from "./JobAssignmentPanel";
import { classifyScopeClause } from "./jobControlAuthoringClient";
import type { AssignableWorker } from "@/domains/users/types";
import { certaintyForClassification, type CertaintyState } from "@/domains/jobs/certainty";
import type { ScopeClassification } from "@/domains/job-control/reconciliation";
import type {
  ScopeClauseView,
  ScopeReconciliationView,
} from "@/server/job-control/reconciliation-read";
import { validateJobBasics } from "@/domains/jobs/validate";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import { SaveAsBlueprintCard } from "./SaveAsBlueprintCard";
import type { Job, JobModules, JobStage } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

/**
 * Job Builder / Editor workspace (admin only).
 *
 * The real create→build→publish spine over the EXISTING api/jobs.js write
 * handlers. No new storage model; every save is a typed PUT and every
 * publish is a real draft→active status flip (which, with the api/jobs.js
 * GET gate, is a genuine office-only→field-visible change).
 *
 * Tabs:
 *   Basics    — name / ref / site context / dates (inline-validated)
 *   Structure — job-level rough-in + fit-off task templates, area groups + areas
 *   Field     — per-job module toggles (what the field crew can do)
 *   Preview   — what an assigned worker will see, derived from the SAVED job
 *   Publish   — the publish checklist + publish / unpublish
 *   More      — honest UC list for capabilities NOT wired here (docs upload,
 *               materials takeoff, labour, scope/PDF AI interpretation)
 *
 * Honesty rules this component holds to:
 *   - Preview + publish validation run against `savedJob` (the persisted
 *     state), never the unsaved form — so they reflect what the field would
 *     ACTUALLY get. A "save to refresh" banner shows when the form is dirty.
 *   - Publish is disabled while there are unsaved changes (publish only
 *     writes status; it must not silently drop structural edits).
 *   - Structure stays editable even when the job carries archived rooms/tasks
 *     (#377). The editable form filters archived items OUT and the save sends
 *     only live rows; api/jobs.js PUT is the retention authority and re-appends
 *     any archived group/area/task the payload omits, so editing the live
 *     structure can't disturb archived history. Archived items render as honest
 *     read-only rows (ArchivedStructureSection) — visible, never editable.
 *
 * Cross-ref:
 *   src/domains/jobs/builder.ts — payload + publish + preview logic (tested)
 *   src/domains/jobs/client.ts — updateJob / publishJob / unpublishJob
 *   api/jobs.js — PUT (update) + the draft GET gate
 */

type DeliverKey = "plans" | "materials" | "gear" | "itps" | "risks";

type TabKey =
  | "overview"
  | "basics"
  | "scope"
  | "structure"
  | "modules"
  | DeliverKey
  | "crew"
  | "preview"
  | "publish"
  | "more";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "basics", label: "Basics" },
  { key: "scope", label: "Scope" },
  { key: "structure", label: "Structure" },
  { key: "modules", label: "Field modules" },
  { key: "plans", label: "Plans & docs" },
  { key: "materials", label: "Materials" },
  { key: "gear", label: "Gear" },
  { key: "itps", label: "ITPs / QA" },
  { key: "risks", label: "Risks & RFIs" },
  { key: "crew", label: "Crew" },
  { key: "preview", label: "Phil preview" },
  { key: "publish", label: "Publish" },
  { key: "more", label: "More" },
];

const TAB_KEYS: ReadonlySet<string> = new Set(TABS.map((t) => t.key));

/**
 * Resolve a deep-link URL hash to a builder tab, or null. Lets a Needs Attention
 * action open the right tab (e.g. `…/builder#publish` for a draft job). Unknown
 * hashes (e.g. `#assigned-field-workers`, which targets the sibling assignment
 * panel) return null — the tab is left on its default. Pure + tested.
 */
export function tabFromHash(hash: string | undefined | null): TabKey | null {
  if (!hash) return null;
  const key = hash.replace(/^#/, "");
  return TAB_KEYS.has(key) ? (key as TabKey) : null;
}

/** Field-facing module toggles, in display order. Other module keys
 *  (switchboards / circuits / levels) round-trip untouched — they're
 *  advanced structural concepts, not field on/off switches. */
const MODULE_TOGGLES: ReadonlyArray<{ key: keyof JobModules; label: string; help: string }> = [
  {
    key: "areas",
    label: "Areas / zones",
    help: "Track work by room/zone. Off = a flat job with no area breakdown.",
  },
  {
    key: "photos",
    label: "Photo evidence",
    help: "Field can capture photo/note evidence against tasks.",
  },
  {
    key: "snags",
    label: "Snags / defects",
    help: "Field can raise defects for the office to action.",
  },
  {
    key: "itps",
    label: "ITP / QA records",
    help: "Field records inspection & test points for sign-off.",
  },
  {
    key: "plans",
    label: "Plans & documents",
    help: "Field can view plans/specs attached to the job.",
  },
  { key: "materials", label: "Materials list", help: "Field can see the job materials list." },
  { key: "hours", label: "Log hours", help: "Field can log hours against this job." },
  { key: "tags", label: "Test tags", help: "Field can record test-and-tag entries." },
  { key: "temps", label: "Temperature logs", help: "Field can record temperature readings." },
  { key: "contacts", label: "Site contacts", help: "Show site contact details to the field." },
];

const ALL_MODULE_KEYS: ReadonlyArray<keyof JobModules> = [
  "areas",
  "snags",
  "photos",
  "hours",
  "materials",
  "tags",
  "temps",
  "plans",
  "contacts",
  "switchboards",
  "circuits",
  "itps",
  "levels",
];

const STAGES: ReadonlyArray<{ stage: JobStage; label: string }> = [
  { stage: "roughIn", label: "Rough-in tasks" },
  { stage: "fitOff", label: "Fit-off tasks" },
];

/* ---- cockpit nav (§4): the tabs, grouped into the rail, plus the map from a
   readiness issue code → the section that owns its fix. ---- */
const ISSUE_SECTION: Record<string, TabKey> = {
  "name-missing": "basics",
  "date-order": "basics",
  "no-site-address": "basics",
  "no-areas": "structure",
  "no-tasks": "structure",
  "blank-task": "structure",
  "area-no-tasks": "structure",
};

/** Preserve the load-bearing tab testids (smoke + deep-links) on the rail. */
const SECTION_TESTID: Partial<Record<TabKey, string>> = {
  structure: "builder-structure-tab",
  preview: "builder-phil-preview-tab",
  publish: "builder-publish-tab",
};

const COCKPIT_GROUPS: ReadonlyArray<{ heading: string; keys: ReadonlyArray<TabKey> }> = [
  { heading: "Build", keys: ["overview", "basics", "scope", "structure", "modules"] },
  { heading: "Deliver", keys: ["plans", "materials", "gear", "itps", "risks", "crew"] },
  { heading: "Ship", keys: ["preview", "publish"] },
  { heading: "More", keys: ["more"] },
];

/**
 * The delivery facets that live on their own dedicated job surfaces. The cockpit
 * surfaces each as a section that links out — it does NOT duplicate the editor
 * (extend, don't fork). `module` (where set) reflects the real per-job field
 * toggle. `external` links a global register rather than a job sub-route.
 */
const DELIVER_LINKS: Record<
  DeliverKey,
  { label: string; desc: string; path: (jobId: string) => string; module?: keyof JobModules; external?: boolean }
> = {
  plans: {
    label: "Plans & documents",
    desc: "Drawings, specs and revisions attached to this job.",
    path: (id) => `/v2/jobs/${id}/plans`,
    module: "plans",
  },
  materials: {
    label: "Materials",
    desc: "Field material requests — approve & order, then confirm delivery.",
    path: (id) => `/v2/jobs/${id}/material-requests`,
    module: "materials",
  },
  gear: {
    label: "Gear — test & tag",
    desc: "The test-and-tag register: who holds what and tag currency. Assign gear to this job's crew there.",
    path: () => `/gear`,
    external: true,
  },
  itps: {
    label: "ITPs / QA",
    desc: "Inspection & test points and hold points recorded against this job.",
    path: (id) => `/v2/jobs/${id}/itps`,
    module: "itps",
  },
  risks: {
    label: "Risks & RFIs",
    desc: "Open RFIs and risks that gate the work before or during the job.",
    path: (id) => `/v2/jobs/${id}/rfis`,
  },
};

/** Office labels for the reconciliation classifications shown in the Inspector. */
const CLAUSE_CLASSIFICATION_LABEL: Record<ScopeClassification, string> = {
  priced: "Priced",
  general_allowance: "General allowance",
  excluded: "Excluded",
  by_others: "By others",
  reuse_existing: "Reuse existing",
  pc_provisional: "PC / provisional",
  variation_trigger: "Variation trigger",
  closeout: "Closeout obligation",
  admin_only: "Admin only",
  unclear: "Not yet classified",
};

export function JobBuilderClient({
  job: initialJob,
  reconciliation = null,
  assignableWorkers = [],
  workersLoadError = null,
}: {
  job: Job;
  /** The confirmed scope reconciliation (server-loaded), or null/missing. Source
   *  of real per-clause certainty for the cockpit Inspector. */
  reconciliation?: ScopeReconciliationView | null;
  /** Assignable field/LH crew (server-loaded) for the cockpit Crew section. */
  assignableWorkers?: ReadonlyArray<AssignableWorker>;
  workersLoadError?: string | null;
}) {
  const router = useRouter();
  const [savedJob, setSavedJob] = useState<Job>(initialJob);
  const [form, setForm] = useState<JobBuilderForm>(() => jobToForm(initialJob));
  const [tab, setTab] = useState<TabKey>("basics");
  // Honour a deep-link hash on mount (e.g. `…/builder#publish`). Runs once,
  // client-only; a non-tab hash leaves the default tab untouched.
  useEffect(() => {
    const hash = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "");
    const t = tabFromHash(hash ? `#${hash}` : null);
    if (t) setTab(t);
    // The legacy #assigned-field-workers anchor (Needs-Attention deep-link) now
    // opens the Crew section, where the assignment panel lives.
    else if (hash === "assigned-field-workers") setTab("crew");
  }, []);
  // Keep savedJob in sync with the server-provided job. A sibling section (e.g.
  // ScopeOfWorkSection) can save + router.refresh(), handing down a fresh `job`
  // prop; without this, its scopeOfWork edits wouldn't reach the review queue /
  // chips until a hard reload. jobToForm ignores scopeOfWork, so a scope-only
  // change leaves the basics/structure form and its dirty state untouched.
  useEffect(() => {
    setSavedJob(initialJob);
  }, [initialJob]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [busy, setBusy] = useState<null | "publish" | "unpublish">(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // #192 — structure presets. Save captures the LAST-SAVED group server-side
  // (same mapper family as job duplication); insert is pure client-side and
  // rides the normal validated save.
  const [presetSaveTarget, setPresetSaveTarget] = useState<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetInsertOpen, setPresetInsertOpen] = useState(false);
  const [presets, setPresets] = useState<StructurePreset[] | null>(null);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [insertPresetId, setInsertPresetId] = useState<string | null>(null);
  const [insertBase, setInsertBase] = useState("");
  const [insertCount, setInsertCount] = useState(1);
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);

  // #224 — rule-based task generation. The apply happens server-side (reads the
  // last-saved structure + the rules), so we gate it on a clean (saved) form and
  // re-fetch the job afterwards.
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genResult, setGenResult] = useState<GenerationSummary | null>(null);

  // #377 — read-only projection of any archived groups/areas/job-level tasks on
  // the SAVED job. The editable form filters archived OUT; we render this mirror
  // as honest read-only rows so the structure stays editable without hiding the
  // archived history. The server re-appends the archived items on save.
  const archivedStructure = useMemo(() => projectArchivedStructure(savedJob), [savedJob]);

  const savedForm = useMemo(() => jobToForm(savedJob), [savedJob]);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm]
  );

  const basicsErrors = validateJobBasics(
    {
      name: form.name,
      siteContactPhone: form.siteContactPhone,
      startDate: form.startDate,
      dueDate: form.dueDate,
    },
    { requireName: true }
  );
  const basicsValid = Object.keys(basicsErrors).length === 0;

  const publishIssues = useMemo(() => validateForPublish(savedJob), [savedJob]);
  const state = publishState(savedJob);
  const fieldVisible = isVisibleToField(savedJob);

  // §4 cockpit: the readiness rollup that drives the rail meter + inspector, and
  // the per-section status badges. Computed over the SAVED job (same honesty rule
  // as preview/publish) plus the live basics validity for the Basics badge.
  const readiness = useMemo(() => buildBuilderReadiness(savedJob), [savedJob]);

  function sectionStatus(key: TabKey): CockpitSectionStatus {
    if (
      key === "modules" ||
      key === "more" ||
      key === "overview" ||
      key === "crew" ||
      key in DELIVER_LINKS
    ) {
      return "none";
    }
    if (key === "publish") return readiness.canPublish ? "ok" : "block";
    if (key === "scope") {
      // Scope owns the reconciliation: a red RAG = real conflicts (block); any
      // un-triaged clause or an amber RAG = needs a look (warn); a clean
      // confirmed reconciliation = ok; no scope/reconciliation yet = none.
      if (reconciledView?.rag === "red") return "block";
      if (untriagedClauses.length > 0 || reconciledView?.rag === "amber") return "warn";
      return reconciledView ? "ok" : "none";
    }
    const all = [...readiness.blockers, ...readiness.warnings];
    // Preview is "what the field sees", so it surfaces the field-lint symptom;
    // every other section owns the issues whose fix lives there.
    const mine =
      key === "preview"
        ? all.filter((i) => i.source === "field")
        : all.filter((i) => (ISSUE_SECTION[i.code] ?? "publish") === key);
    if ((key === "basics" && !basicsValid) || mine.some((i) => i.severity === "error")) {
      return "block";
    }
    if (mine.some((i) => i.severity === "warning")) return "warn";
    return "ok";
  }

  function goToIssue(issue: ReadinessIssue) {
    setTab(ISSUE_SECTION[issue.code] ?? "publish");
  }

  // §4 certainty: per-clause certainty derived from the CONFIRMED reconciliation
  // — the only real source (the saved job carries no classification). The review
  // queue's optimistic overrides layer on top so chips + counts update the
  // instant a clause is classified (the write persists in the background). We
  // never fake a green: an un-triaged clause has no certainty entry → no chip.
  const reconciledView =
    reconciliation && reconciliation.status === "reconciled" ? reconciliation : null;
  const clauseInfo = useMemo(() => {
    const m = new Map<string, { certainty: CertaintyState; view: ScopeClauseView }>();
    if (reconciledView) {
      for (const c of reconciledView.clauses) {
        m.set(c.clauseId, { certainty: certaintyForClassification(c.classification), view: c });
      }
    }
    return m;
  }, [reconciledView]);

  // Optimistic classifications applied via the review queue this session.
  const [classifiedOverrides, setClassifiedOverrides] = useState<Map<string, ScopeClassification>>(
    () => new Map()
  );

  /** Effective certainty for a clause: a fresh override wins, else the confirmed
   *  reconciliation, else none (un-triaged). */
  const clauseState = useCallback(
    (
      clauseId: string
    ): { certainty: CertaintyState; classification: ScopeClassification } | null => {
      const ov = classifiedOverrides.get(clauseId);
      if (ov) return { certainty: certaintyForClassification(ov), classification: ov };
      const info = clauseInfo.get(clauseId);
      if (info) return { certainty: info.certainty, classification: info.view.classification };
      return null;
    },
    [classifiedOverrides, clauseInfo]
  );

  const certaintyByClauseId = useMemo(() => {
    const m = new Map<string, CertaintyState>();
    for (const [id, info] of clauseInfo) m.set(id, info.certainty);
    for (const [id, cls] of classifiedOverrides) m.set(id, certaintyForClassification(cls));
    return m;
  }, [clauseInfo, classifiedOverrides]);

  // The cockpit Inspector's selected row (a scope line or an area), or null →
  // the Inspector falls back to the build-readiness view.
  const [selectedRow, setSelectedRow] = useState<InspectorRow | null>(null);

  function selectArea(groupName: string, area: AreaRowForm) {
    setSelectedRow({
      entity: "area",
      id: area.id ?? null,
      title: area.name || "Untitled area",
      group: groupName,
      spaceType: (area.spaceType ?? "") || null,
      hasCustomTasks: areaHasOverride(area),
    });
  }

  function selectClause(clauseId: string, title: string, detail: string) {
    const st = clauseState(clauseId);
    const view = clauseInfo.get(clauseId)?.view ?? null;
    setSelectedRow({
      entity: "clause",
      id: clauseId,
      title: title.trim() || "Untitled scope line",
      detail: detail.trim() || null,
      certainty: st?.certainty ?? null,
      classificationLabel: st ? CLAUSE_CLASSIFICATION_LABEL[st.classification] : null,
      boqLineCount: view?.boqLineCount ?? 0,
      deliveredByCount: view?.deliveredByCount ?? 0,
      requiredEvidenceCount: view?.requiredEvidenceCount ?? 0,
      warningText: view?.warningText ?? null,
    });
  }

  // ── §4 review queue: keyboard-fast classify of the un-triaged scope lines ──
  const scopeClauses = useMemo<ReviewClause[]>(
    () =>
      (savedJob.scopeOfWork ?? [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, title: c.title, detail: c.detail || null })),
    [savedJob.scopeOfWork]
  );
  /** Needs triage = no certainty yet (untracked) OR still `needs_review` (an
   *  `unclear` reconciliation clause). A real classification → `confirmed` drops
   *  it from the queue. */
  const untriagedClauses = useMemo(
    () =>
      scopeClauses.filter((c) => {
        const st = clauseState(c.id);
        return st === null || st.certainty === "needs_review";
      }),
    [scopeClauses, clauseState]
  );

  // Built here (after reconciledView + untriagedClauses) so the Scope section's
  // status can read them without a TDZ trap.
  const cockpitNav: CockpitNavGroup[] = COCKPIT_GROUPS.map((g) => ({
    heading: g.heading,
    items: g.keys.map((key) => ({
      key,
      label: TABS.find((t) => t.key === key)!.label,
      status: sectionStatus(key),
      testId: SECTION_TESTID[key],
    })),
  }));

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewSession, setReviewSession] = useState<ReviewClause[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewCleared = reviewSession.filter((c) => classifiedOverrides.has(c.id)).length;
  // Each classify is a read-modify-write of the one reconciliation blob (no CAS).
  // Serialise the confirms through a tail promise so a fast reviewer's writes
  // can't interleave and clobber each other (last-write-wins lost update).
  const confirmTail = useRef<Promise<unknown>>(Promise.resolve());

  function openReview() {
    setReviewSession(untriagedClauses);
    setReviewIndex(0);
    setReviewError(null);
    setReviewOpen(true);
  }
  function classifyInReview(clauseId: string, classification: ScopeClassification) {
    // Optimistic: record + advance so chips/counts update now; persist to the
    // real reconciliation in the background, strictly serialised. On failure
    // revert the override AND rewind to re-present the clause — we never leave a
    // green chip, nor silently drop a clause, for a classification that didn't save.
    setClassifiedOverrides((m) => new Map(m).set(clauseId, classification));
    setReviewIndex((i) => i + 1);
    setReviewError(null);
    const session = reviewSession;
    confirmTail.current = confirmTail.current
      .catch(() => {}) // a prior failure must not stall the chain
      .then(() => classifyScopeClause(savedJob.id, clauseId, classification))
      .then((res) => {
        if (res && !res.ok) {
          setClassifiedOverrides((m) => {
            const next = new Map(m);
            next.delete(clauseId);
            return next;
          });
          const pos = session.findIndex((c) => c.id === clauseId);
          if (pos >= 0) setReviewIndex((i) => Math.min(i, pos)); // re-present, never skip an unsaved line
          const title = session.find((c) => c.id === clauseId)?.title ?? "that scope line";
          setReviewError(`Couldn't save "${title}" — try again.`);
        }
      });
  }

  async function save() {
    if (!basicsValid) {
      setTab("basics");
      return;
    }
    setSaving(true);
    setSaveError(null);
    // #377 — the payload carries only LIVE structure (jobToForm filters archived
    // out, buildUpdatePayload only sends non-archived rows). The server is the
    // retention authority: it re-appends any archived group/area/task the
    // payload omits, so structure stays fully editable on jobs with archived
    // items without disturbing them. No client-side freeze.
    const payload = buildUpdatePayload(savedJob.id, form);
    const res = await updateJob(payload);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error.message);
      return;
    }
    setSavedJob(res.data.job);
    setForm(jobToForm(res.data.job));
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 2000);
    router.refresh();
  }

  // #224 — apply the task-generation rules to this job's areas. mode 'fill-empty'
  // only fills empty areas; 'merge' is the explicit overwrite of non-empty lists
  // (id-preserving). Runs server-side over the SAVED structure, then re-fetches.
  async function generateTasks(mode: "fill-empty" | "merge") {
    setGenBusy(true);
    setGenError(null);
    try {
      const res = await fetch("/api/generate-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: savedJob.id, mode }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; changed?: boolean; summary?: GenerationSummary; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setGenError((body && body.error) || `Generation failed (${res.status})`);
        return;
      }
      setGenResult(body.summary ?? null);
      if (body.changed) {
        const fresh = await getJobForEdit(savedJob.id);
        if (fresh.ok) {
          setSavedJob(fresh.data.job);
          setForm(jobToForm(fresh.data.job));
        }
        router.refresh();
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenBusy(false);
    }
  }

  async function runStatus(action: "publish" | "unpublish") {
    setBusy(action);
    setPublishError(null);
    const res = await (action === "publish" ? publishJob(savedJob.id) : unpublishJob(savedJob.id));
    setBusy(null);
    if (!res.ok) {
      setPublishError(res.error.message);
      return;
    }
    setSavedJob(res.data.job);
    setForm(jobToForm(res.data.job));
    router.refresh();
  }

  /* ---- form updaters ---- */
  function set<K extends keyof JobBuilderForm>(key: K, value: JobBuilderForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setModule(key: keyof JobModules, value: boolean) {
    setForm((f) => ({ ...f, modules: { ...f.modules, [key]: value } }));
  }
  function jobTasks(stage: JobStage): TaskRowForm[] {
    return stage === "roughIn" ? form.roughInTasks : form.fitOffTasks;
  }
  function setJobTasks(stage: JobStage, rows: TaskRowForm[]) {
    set(stage === "roughIn" ? "roughInTasks" : "fitOffTasks", rows);
  }

  return (
    <div className="space-y-4">
      {/* Header: name, status, dirty/save */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle className="break-words">{savedJob.name}</CardTitle>
              <Pill tone={statusTone(savedJob.status)}>{statusLabel(savedJob.status)}</Pill>
            </div>
            <CardDescription className="mt-1">
              {fieldVisible ? (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" /> Visible to the field
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Office-only (not yet
                  published)
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              data-testid="save-changes"
              onClick={save}
              disabled={!dirty || saving || !basicsValid}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              {saving ? "Saving…" : dirty ? "Save changes" : savedTick ? "Saved ✓" : "Saved"}
            </Button>
            <span
              data-testid="save-state"
              className="text-[11px] uppercase tracking-wider text-text-muted"
            >
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
          </div>
        </div>
        {saveError ? (
          <p
            role="alert"
            className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          >
            Couldn&rsquo;t save: {saveError}
          </p>
        ) : null}
        {!basicsValid ? (
          <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Fix the highlighted fields in <strong>Basics</strong> before saving.
          </p>
        ) : null}
      </Card>

      {/* §4 cockpit: rail (readiness meter + section nav) · canvas (active
          section) · inspector. The sections themselves — and all save/publish/
          preset/generate logic — are unchanged; only the chrome is upgraded. */}
      <JobBuilderCockpit
        readiness={readiness}
        nav={cockpitNav}
        activeKey={tab}
        onSelect={(k) => {
          setReviewOpen(false);
          setTab(k as TabKey);
        }}
        onMeterClick={() => {
          setReviewOpen(false);
          setTab("publish");
        }}
        reviewCount={untriagedClauses.length}
        reviewActive={reviewOpen}
        onOpenReview={openReview}
        canvas={
          reviewOpen ? (
            <ReviewQueue
              session={reviewSession}
              index={reviewIndex}
              cleared={reviewCleared}
              error={reviewError}
              onClassify={classifyInReview}
              onSkip={() => setReviewIndex((i) => i + 1)}
              onClose={() => setReviewOpen(false)}
            />
          ) : (
            renderActiveSection()
          )
        }
        inspector={
          <Inspector
            target={selectedRow ? { kind: "row", row: selectedRow } : { kind: "readiness" }}
            readiness={readiness}
            onGoToIssue={goToIssue}
            onDeselect={() => setSelectedRow(null)}
          />
        }
      />

      {/* #192 — save a saved group as a reusable preset */}
      <Modal
        open={presetSaveTarget !== null}
        onClose={() => {
          if (presetBusy) return;
          setPresetSaveTarget(null);
        }}
        title="Save group as preset"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Captures the <span className="font-medium text-text">last saved</span> version of this
            group — areas, space types and custom task lists; no progress, no ids.
            {dirty ? " You have unsaved changes — save the job first to include them." : ""}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-text">Preset name</span>
            <input
              autoFocus
              className={inputClass}
              value={presetName}
              maxLength={80}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Townhouse unit — standard"
            />
          </label>
          {presetError ? (
            <p role="alert" className="text-sm text-state-danger">
              {presetError}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={presetBusy} onClick={() => setPresetSaveTarget(null)}>
              Cancel
            </Button>
            <Button disabled={presetBusy} onClick={() => void confirmSavePreset()}>
              {presetBusy ? "Saving…" : "Save preset"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* #192 — insert a preset n times with auto-numbered names */}
      <Modal
        open={presetInsertOpen}
        onClose={() => setPresetInsertOpen(false)}
        title="Add groups from a preset"
      >
        <div className="space-y-4">
          {presetsError ? (
            <p role="alert" className="text-sm text-state-danger">
              {presetsError}
            </p>
          ) : presets === null ? (
            <p className="text-sm text-text-muted">Loading presets…</p>
          ) : presets.length === 0 ? (
            <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">
              No presets yet. Save any group as a preset first — it&rsquo;ll show up here for every
              job.
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Preset" className="space-y-2">
                {presets.map((preset) => {
                  const active = preset.id === insertPresetId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setInsertPresetId(preset.id);
                        if (!insertBase) setInsertBase(preset.group.name);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-card border p-3 text-left text-sm",
                        active
                          ? "border-brand-navy bg-brand-navy text-text-inverse"
                          : "border-border bg-surface text-text hover:bg-surface-subtle"
                      )}
                    >
                      <span className="min-w-0 truncate font-medium">{preset.name}</span>
                      <span className={active ? "text-text-inverse/80" : "text-text-muted"}>
                        {preset.group.areas.length} areas
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-text">Group name base</span>
                  <input
                    className={inputClass}
                    value={insertBase}
                    onChange={(e) => setInsertBase(e.target.value)}
                    placeholder="e.g. Unit"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-text">Copies</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    className={cn(inputClass, "w-20")}
                    value={insertCount}
                    onChange={(e) =>
                      setInsertCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
                    }
                  />
                </label>
              </div>
              {insertPresetId ? (
                <p className="text-xs text-text-muted">
                  {`Will add: ${autoNumberedNames(
                    insertBase ||
                      (presets.find((p) => p.id === insertPresetId)?.group.name ?? "Group"),
                    insertCount,
                    form.areaGroups.map((g) => g.name)
                  ).join(", ")}`}
                </p>
              ) : null}
              {presetError ? (
                <p role="alert" className="text-sm text-state-danger">
                  {presetError}
                </p>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={() => setPresetInsertOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={confirmInsertPreset} disabled={!insertPresetId}>
                  Insert
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );

  /* ---- the active section node fed into the cockpit canvas ---- */
  function renderActiveSection() {
    switch (tab) {
      case "overview":
        return renderOverview();
      case "basics":
        return (
          <>
            {renderBasics()}
            {/* #228: client + contract commercial context — admin-only, its
                own PUT (the scopeOfWork precedent). */}
            <div className="mt-4">
              <ClientContractSection job={savedJob} />
            </div>
          </>
        );
      case "scope":
        return renderScope();
      case "crew":
        return renderCrew();
      case "plans":
      case "materials":
      case "gear":
      case "itps":
      case "risks":
        return renderDeliverLink(tab);
      case "structure":
        return renderStructure();
      case "modules":
        return renderModules();
      case "preview":
        return renderPreview();
      case "publish":
        return renderPublish();
      case "more":
        return renderMore();
      default:
        return null;
    }
  }

  /* ============================ OVERVIEW ============================ */
  function renderOverview() {
    const struct = summariseStructure(savedJob);
    const preview = buildPhilPreview(savedJob);
    const fieldTools = preview.sections.filter((s) => s.enabled).length;
    const stats: Array<{ label: string; value: number; to: TabKey; danger?: boolean }> = [
      { label: "Blockers", value: readiness.blockingCount, to: "publish", danger: true },
      { label: "Warnings", value: readiness.warningCount, to: "publish" },
      { label: "Scope to triage", value: untriagedClauses.length, to: "scope" },
      { label: "Areas", value: struct.areaCount, to: "structure" },
    ];
    return (
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <CardTitle className="break-words">{savedJob.name}</CardTitle>
                <Pill tone={statusTone(savedJob.status)}>{statusLabel(savedJob.status)}</Pill>
              </div>
              <CardDescription className="mt-1">
                {[
                  savedJob.ref && `Ref ${savedJob.ref}`,
                  savedJob.typeName ?? (savedJob.type || null),
                  savedJob.siteAddress || null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No ref, type or address yet"}
              </CardDescription>
            </div>
            <Pill tone={readiness.tone}>{readiness.stateLabel}</Pill>
          </div>
        </Card>

        <Card>
          <CardTitle>Build readiness</CardTitle>
          <CardDescription className="mt-1">
            The running rollup of what stands between this job and the field.
          </CardDescription>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setTab(s.to)}
                className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-left transition-colors hover:border-brand-navy"
              >
                <span
                  className={cn(
                    "block font-mono text-lg font-semibold",
                    s.danger && s.value > 0 ? "text-state-danger" : "text-text"
                  )}
                >
                  {s.value}
                </span>
                <span className="block text-[11px] text-text-muted">{s.label}</span>
              </button>
            ))}
          </div>
          {readiness.blockers.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {readiness.blockers.slice(0, 3).map((b) => (
                <li key={b.code} className="flex items-start gap-2 text-sm text-state-danger">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {b.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-state-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> No blockers — clear to publish.
            </p>
          )}
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <CardTitle>What the field sees</CardTitle>
          </div>
          {preview.emptyReason ? (
            <p className="mt-2 text-sm text-text-muted">{preview.emptyReason}</p>
          ) : (
            <p className="mt-2 text-sm text-text-muted">
              {struct.areaCount} area{struct.areaCount === 1 ? "" : "s"} ·{" "}
              {struct.roughInTaskCount + struct.fitOffTaskCount} job-level task template
              {struct.roughInTaskCount + struct.fitOffTaskCount === 1 ? "" : "s"} · {fieldTools} field
              tool{fieldTools === 1 ? "" : "s"} on.
              {preview.isVisibleToField
                ? " Published — visible to assigned crew."
                : " Draft — office-only."}
            </p>
          )}
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setTab("preview")}>
            <Eye className="h-4 w-4" aria-hidden="true" /> Open Phil preview
          </Button>
        </Card>
      </div>
    );
  }

  /* ============================ CREW ============================ */
  function renderCrew() {
    return (
      <JobAssignmentPanel
        jobId={savedJob.id}
        jobName={savedJob.name}
        initialWorkers={assignableWorkers}
        loadError={workersLoadError}
      />
    );
  }

  /* ===================== DELIVER (link-out facets) ==================== */
  function renderDeliverLink(key: DeliverKey) {
    const cfg = DELIVER_LINKS[key];
    const moduleOn = cfg.module ? moduleEnabled(savedJob, cfg.module) : null;
    return (
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{cfg.label}</CardTitle>
            <CardDescription className="mt-1">{cfg.desc}</CardDescription>
          </div>
          {moduleOn !== null ? (
            <Pill tone={moduleOn ? "success" : "neutral"}>
              Field module {moduleOn ? "on" : "off"}
            </Pill>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href={cfg.path(savedJob.id) as Route}
            className="inline-flex items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse"
          >
            Open {cfg.label} <span aria-hidden="true">→</span>
          </Link>
          <span className="text-xs text-text-muted">
            {cfg.external
              ? "Lives on its own register — the builder links out rather than duplicating it."
              : "Lives on its own job surface — the builder links out rather than duplicating it."}
          </span>
        </div>
      </Card>
    );
  }

  /* ============================ SCOPE INTAKE ============================ */
  function renderScope() {
    return (
      <div className="space-y-4">
        <Card>
          <CardTitle>Scope intake</CardTitle>
          <CardDescription className="mt-1">
            The agreed scope — the one source the structure, tasks and quote build from.
            Classify each line so nothing becomes silent field work; the review queue triages
            the unclassified ones fast.
          </CardDescription>
          {untriagedClauses.length > 0 ? (
            <Button
              size="sm"
              className="mt-3"
              data-testid="scope-open-review"
              onClick={openReview}
            >
              <ListChecks className="h-4 w-4" aria-hidden="true" />
              Review {untriagedClauses.length} unclassified line
              {untriagedClauses.length === 1 ? "" : "s"}
            </Button>
          ) : reconciledView ? (
            <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-state-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Every scope line classified.
            </p>
          ) : null}
        </Card>

        <ScopeOfWorkSection
          job={savedJob}
          certaintyByClauseId={certaintyByClauseId}
          selectedClauseId={selectedRow?.entity === "clause" ? selectedRow.id : null}
          onInspectClause={selectClause}
        />

        {/* The confirmed scope-vs-quote reconciliation (RAG + findings + clause
            table). Renders its own honest "no reconciliation yet" state.
            Interactive here (#366 AC2): each open finding carries resolve /
            accept-with-reason actions; the write goes through the confirm route
            and router.refresh() re-reads the persisted result. */}
        {reconciliation ? <ScopeReconciliationStatus view={reconciliation} interactive /> : null}
      </div>
    );
  }

  /* ============================ BASICS ============================ */
  function renderBasics() {
    return (
      <Card>
        <CardTitle>Basics</CardTitle>
        <CardDescription className="mt-1">
          The job header and site context. Name is required; everything else is optional and can be
          filled in over time.
        </CardDescription>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Job name" required error={basicsErrors.name} className="sm:col-span-2">
            <input
              className={cn(inputClass, basicsErrors.name && "border-rose-400")}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="Reference">
            <input
              className={inputClass}
              value={form.ref}
              onChange={(e) => set("ref", e.target.value)}
            />
          </Field>
          <Field label="Job type" help="The job's work type, set when the job is created.">
            <input
              className={cn(inputClass, "bg-surface-subtle text-text-muted")}
              value={savedJob.typeName ?? form.type ?? "—"}
              readOnly
            />
          </Field>
          <Field label="Site address" className="sm:col-span-2">
            <input
              className={inputClass}
              value={form.siteAddress}
              onChange={(e) => set("siteAddress", e.target.value)}
              placeholder="12 Magill Rd, Stepney SA 5069"
            />
          </Field>
          <Field label="Site contact">
            <input
              className={inputClass}
              value={form.siteContactName}
              onChange={(e) => set("siteContactName", e.target.value)}
              placeholder="Name"
            />
          </Field>
          <Field label="Contact phone" error={basicsErrors.siteContactPhone}>
            <input
              className={cn(inputClass, basicsErrors.siteContactPhone && "border-rose-400")}
              value={form.siteContactPhone}
              onChange={(e) => set("siteContactPhone", e.target.value)}
              placeholder="0421 558 902"
            />
          </Field>
          <Field label="Start date" error={basicsErrors.startDate}>
            <input
              type="date"
              className={cn(inputClass, basicsErrors.startDate && "border-rose-400")}
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
            />
          </Field>
          <Field label="Target date" error={basicsErrors.dueDate}>
            <input
              type="date"
              className={cn(inputClass, basicsErrors.dueDate && "border-rose-400")}
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
          <Field label="Access notes" className="sm:col-span-2">
            <textarea
              className={cn(inputClass, "h-16 resize-none")}
              value={form.accessNotes}
              onChange={(e) => set("accessNotes", e.target.value)}
              placeholder="Gate code, lockbox, who to call on arrival…"
            />
          </Field>
          <Field label="Parking notes" className="sm:col-span-2">
            <textarea
              className={cn(inputClass, "h-16 resize-none")}
              value={form.parkingNotes}
              onChange={(e) => set("parkingNotes", e.target.value)}
            />
          </Field>
          <Field label="Safety notes" className="sm:col-span-2">
            <textarea
              className={cn(inputClass, "h-16 resize-none")}
              value={form.safetyNotes}
              onChange={(e) => set("safetyNotes", e.target.value)}
              placeholder="Asbestos register, live switchboard, confined space…"
            />
          </Field>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.inductionRequired}
              onChange={(e) => set("inductionRequired", e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm text-text">
              Site induction required before the crew attends
            </span>
          </label>
        </div>
      </Card>
    );
  }

  /* ============================ STRUCTURE ============================ */
  function renderStructure() {
    return (
      <div className="space-y-4">
        {/* #224 — rule-based task generation */}
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Generate tasks from rules</CardTitle>
              <CardDescription className="mt-1">
                Fill every empty area that matches a rule with its task lists — a
                reviewed starting point, never auto-published. Non-empty areas are
                left alone unless you choose to merge.{" "}
                <a
                  href="/settings/task-rules"
                  className="font-medium text-brand-navy underline underline-offset-2"
                >
                  Manage rules
                </a>
                .
              </CardDescription>
            </div>
            <Button
              size="sm"
              data-testid="generate-tasks"
              disabled={genBusy || dirty}
              onClick={() => void generateTasks("fill-empty")}
            >
              {genBusy ? "Generating…" : "Generate tasks"}
            </Button>
          </div>
          {dirty ? (
            <p className="mt-2 text-xs text-text-muted">
              Save your changes first — generation runs over the saved structure.
            </p>
          ) : null}
          {genError ? (
            <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {genError}
            </p>
          ) : null}
          {genResult ? (
            <div className="mt-2 rounded-card border border-border bg-surface-raised px-3 py-2 text-sm">
              {genResult.areasFilled > 0 ? (
                <p className="text-text">
                  Filled {genResult.areasFilled} area{genResult.areasFilled === 1 ? "" : "s"}
                  {genResult.roughInAdded > 0 ? ` · ${genResult.roughInAdded} rough-in` : ""}
                  {genResult.fitOffAdded > 0 ? ` · ${genResult.fitOffAdded} fit-off` : ""}. Review
                  and edit below, then save.
                </p>
              ) : (
                <p className="text-text-muted">
                  No empty areas matched a rule.
                  {genResult.areasMatched === 0
                    ? " No rule matched this job's type or area names."
                    : ""}
                </p>
              )}
              {genResult.areasSkippedNonEmpty > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted">
                    {genResult.areasSkippedNonEmpty} matching area
                    {genResult.areasSkippedNonEmpty === 1 ? "" : "s"} already had tasks and{" "}
                    {genResult.areasSkippedNonEmpty === 1 ? "was" : "were"} left alone.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="generate-tasks-merge"
                    disabled={genBusy || dirty}
                    onClick={() => void generateTasks("merge")}
                  >
                    Merge into those too
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <CardTitle>Default task lists</CardTitle>
          <CardDescription className="mt-1">
            The default rough-in and fit-off checklist every area inherits. Stages are fixed
            (rough-in → fit-off). An area can carry its own task list to override these.
          </CardDescription>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {STAGES.map(({ stage, label }) => renderTaskList(stage, label))}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Areas &amp; zones</CardTitle>
              <CardDescription className="mt-1">
                Group the job into areas the field works against (e.g. Level 1 → Unit 1). Leave
                empty for a flat job, or turn off the Areas module.
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                data-testid="add-from-preset"
                size="sm"
                variant="ghost"
                onClick={() => void openInsertPresets()}
              >
                From preset
              </Button>
              <Button data-testid="add-group" size="sm" variant="secondary" onClick={addGroup}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Group
              </Button>
            </div>
          </div>

          {form.areaGroups.length === 0 ? (
            <p className="mt-4 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-6 text-center text-sm text-text-muted">
              No areas yet. Add a group to start, or keep it flat and define work with the task
              templates above.
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {form.areaGroups.map((group, gi) => (
                <li key={gi} className="rounded-card border border-border bg-surface p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className={cn(inputClass, "font-display font-semibold")}
                      value={group.name}
                      onChange={(e) => updateGroupName(gi, e.target.value)}
                      placeholder="Group name (e.g. Level 1)"
                    />
                    {group.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPresetSaveTarget(gi);
                          setPresetName(group.name ? `${group.name} preset` : "");
                          setPresetError(null);
                        }}
                        aria-label={`Save ${group.name || "group"} as preset`}
                      >
                        Save as preset
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeGroup(gi)}
                      aria-label="Remove group"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2 pl-1">
                    {group.areas.map((area, ai) => (
                      <li
                        key={ai}
                        className={cn(
                          "flex flex-wrap items-center gap-2 rounded-card px-1",
                          selectedRow?.entity === "area" &&
                            area.id != null &&
                            selectedRow.id === area.id
                            ? "ring-1 ring-brand-navy"
                            : ""
                        )}
                      >
                        <input
                          className={cn(inputClass, "min-w-[140px] flex-1")}
                          value={area.name}
                          onChange={(e) => updateArea(gi, ai, { name: e.target.value })}
                          placeholder="Area name (e.g. Unit 1)"
                        />
                        <input
                          className={cn(inputClass, "min-w-[120px] flex-1")}
                          value={area.spaceType ?? ""}
                          onChange={(e) => updateArea(gi, ai, { spaceType: e.target.value })}
                          placeholder="Space type (optional)"
                        />
                        {areaHasOverride(area) ? (
                          <Pill tone="neutral" className="text-[10px] uppercase">
                            custom tasks
                          </Pill>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => selectArea(group.name, area)}
                          aria-label="Inspect area"
                        >
                          <PanelRight className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeArea(gi, ai)}
                          aria-label="Remove area"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    data-testid="add-area"
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => addArea(gi)}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" /> Area
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ArchivedStructureSection archived={archivedStructure} />
      </div>
    );
  }

  function renderTaskList(stage: JobStage, label: string) {
    const rows = jobTasks(stage);
    return (
      <div className="rounded-card border border-border bg-surface p-3">
        <p className="font-display text-sm font-semibold text-text">{label}</p>
        {rows.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">No tasks yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {rows.map((row, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <input
                  className={inputClass}
                  value={row.name}
                  onChange={(e) => {
                    const next = rows.slice();
                    next[idx] = { ...next[idx], name: e.target.value } as TaskRowForm;
                    setJobTasks(stage, next);
                  }}
                  placeholder="Task name"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setJobTasks(
                      stage,
                      rows.filter((_, i) => i !== idx)
                    )
                  }
                  aria-label="Remove task"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          data-testid={stage === "roughIn" ? "add-rough-in-task" : "add-fit-off-task"}
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => setJobTasks(stage, [...rows, { name: "" }])}
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Task
        </Button>
      </div>
    );
  }

  /* ===================== structure presets (#192) ==================== */
  async function openInsertPresets() {
    setPresetInsertOpen(true);
    setPresetError(null);
    if (presets === null) {
      const r = await listStructurePresets();
      if (r.ok) {
        setPresets(r.data.presets as StructurePreset[]);
        setPresetsError(null);
      } else {
        setPresetsError(r.error.message || "Couldn't load presets.");
      }
    }
  }

  async function confirmSavePreset() {
    if (presetSaveTarget === null || presetBusy) return;
    const group = savedForm.areaGroups[presetSaveTarget];
    const groupId = form.areaGroups[presetSaveTarget]?.id;
    if (!group || !groupId) return;
    const trimmed = presetName.trim();
    if (!trimmed) {
      setPresetError("Give the preset a name.");
      return;
    }
    setPresetBusy(true);
    setPresetError(null);
    const r = await captureStructurePreset({ jobId: savedJob.id, groupId, name: trimmed });
    setPresetBusy(false);
    if (!r.ok) {
      setPresetError(
        r.error.status === 409
          ? "A preset with that name already exists."
          : r.error.message || "Couldn't save the preset."
      );
      return;
    }
    setPresets(null); // refetch next time — the list changed
    setPresetSaveTarget(null);
    setPresetName("");
  }

  function confirmInsertPreset() {
    const preset = (presets ?? []).find((p) => p.id === insertPresetId);
    if (!preset) {
      setPresetError("Pick a preset to insert.");
      return;
    }
    const names = autoNumberedNames(
      insertBase || preset.group.name,
      insertCount,
      form.areaGroups.map((g) => g.name)
    );
    set("areaGroups", [...form.areaGroups, ...instantiatePreset(preset, names)]);
    setPresetInsertOpen(false);
    setInsertPresetId(null);
    setInsertBase("");
    setInsertCount(1);
    setPresetError(null);
  }

  /* area-group / area mutators */
  function addGroup() {
    set("areaGroups", [...form.areaGroups, { name: "", areas: [] }]);
  }
  function removeGroup(gi: number) {
    set(
      "areaGroups",
      form.areaGroups.filter((_, i) => i !== gi)
    );
  }
  function updateGroupName(gi: number, name: string) {
    const next = form.areaGroups.slice();
    next[gi] = { ...next[gi]!, name };
    set("areaGroups", next);
  }
  function addArea(gi: number) {
    const next = form.areaGroups.slice();
    next[gi] = { ...next[gi]!, areas: [...next[gi]!.areas, { name: "" }] };
    set("areaGroups", next);
  }
  function removeArea(gi: number, ai: number) {
    const next = form.areaGroups.slice();
    next[gi] = { ...next[gi]!, areas: next[gi]!.areas.filter((_, i) => i !== ai) };
    set("areaGroups", next);
  }
  function updateArea(gi: number, ai: number, patch: Partial<AreaRowForm>) {
    const next = form.areaGroups.slice();
    const areas = next[gi]!.areas.slice();
    areas[ai] = { ...areas[ai]!, ...patch };
    next[gi] = { ...next[gi]!, areas };
    set("areaGroups", next);
  }

  /* ============================ MODULES ============================ */
  function renderModules() {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-text-muted" aria-hidden="true" />
          <CardTitle>Field modules</CardTitle>
        </div>
        <CardDescription className="mt-1">
          What the field crew can do on this job. Turning a module off hides it from the Phil app
          for this job (it doesn&rsquo;t delete any data).
        </CardDescription>
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border">
          {MODULE_TOGGLES.map((m) => {
            const on = Boolean(form.modules[m.key] ?? moduleEnabled(savedJob, m.key));
            return (
              <li key={m.key} className="flex items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <p className="font-display text-sm font-semibold text-text">{m.label}</p>
                  <p className="text-xs text-text-muted">{m.help}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={m.label}
                  onClick={() => setModule(m.key, !on)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-pill border transition-colors",
                    on ? "border-brand-navy bg-brand-navy" : "border-border bg-surface-subtle"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                      on ? "left-[22px]" : "left-0.5"
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }

  /* ============================ PREVIEW ============================ */
  function renderPreview() {
    const preview = buildPhilPreview(savedJob);
    return (
      <div className="space-y-4">
        {dirty ? (
          <div className="flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              This preview reflects the <strong>last saved</strong> version. Save your changes to
              see them here and in what the field gets.
            </span>
          </div>
        ) : null}
        <Card>
          <div className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <CardTitle>What the field will see</CardTitle>
          </div>
          <CardDescription className="mt-1">
            Derived from the saved job structure — the same data the Phil app renders. Not a mock.
          </CardDescription>

          <div className="mt-3 rounded-card border border-border bg-surface p-3">
            <p className="font-display text-base font-semibold text-text">{preview.jobName}</p>
            <p className="text-sm text-text-muted">
              {[preview.ref && `Ref ${preview.ref}`, preview.siteAddress]
                .filter(Boolean)
                .join(" · ") || "No ref or address yet"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Pill tone={preview.isVisibleToField ? "success" : "neutral"}>
                {preview.isVisibleToField ? "Published — visible" : "Draft — office only"}
              </Pill>
              {preview.inductionRequired ? <Pill tone="warning">Induction required</Pill> : null}
            </div>
          </div>

          {preview.emptyReason ? (
            <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-4 text-sm text-text-muted">
              {preview.emptyReason}
            </p>
          ) : (
            <>
              {preview.stages.length > 0 ? (
                <div className="mt-3">
                  <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                    Stages
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {preview.stages.map((s) => (
                      <Pill key={s.stage} tone="navy">
                        {s.label} · {s.jobLevelTaskCount} task{s.jobLevelTaskCount === 1 ? "" : "s"}
                      </Pill>
                    ))}
                  </div>
                </div>
              ) : null}

              {preview.areas.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {preview.areas.map((a, i) => (
                    <li
                      key={i}
                      className="rounded-card border border-border bg-surface p-3 text-sm"
                    >
                      <p className="font-display font-semibold text-text">
                        {a.groupName} · {a.areaName}
                        {a.spaceType ? (
                          <span className="ml-1 text-text-muted">({a.spaceType})</span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        Rough-in: {a.roughInTasks.length ? a.roughInTasks.join(", ") : "—"}
                      </p>
                      <p className="text-xs text-text-muted">
                        Fit-off: {a.fitOffTasks.length ? a.fitOffTasks.join(", ") : "—"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}

          <div className="mt-3">
            <p className="font-display text-xs uppercase tracking-wider text-text-muted">
              Field tools
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {preview.sections.map((s) => (
                <Pill key={s.key} tone={s.enabled ? "success" : "neutral"}>
                  {s.enabled ? "✓" : "—"} {s.label}
                </Pill>
              ))}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  /* ============================ PUBLISH ============================ */
  function renderPublish() {
    const errors = publishIssues.filter((i) => i.severity === "error");
    const warnings = publishIssues.filter((i) => i.severity === "warning");
    const ready = canPublish(publishIssues);

    return (
      <div className="space-y-4">
        <Card>
          <div className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <CardTitle>Publish checklist</CardTitle>
          </div>
          <CardDescription className="mt-1">
            Checks run against the <strong>saved</strong> job. Errors block publishing; warnings are
            advisory.
          </CardDescription>

          {dirty ? (
            <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You have unsaved changes. Save first — publishing only writes the status, so unsaved
              edits wouldn&rsquo;t be included.
            </p>
          ) : null}

          <ul className="mt-4 space-y-2">
            {errors.length === 0 ? (
              <li className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> No blocking issues.
              </li>
            ) : (
              errors.map((i) => (
                <li key={i.code} className="flex items-start gap-2 text-sm text-rose-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{" "}
                  {i.message}
                </li>
              ))
            )}
            {warnings.map((i) => (
              <li key={i.code} className="flex items-start gap-2 text-sm text-amber-800">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {i.message}
              </li>
            ))}
          </ul>
        </Card>

        <SaveAsBlueprintCard jobId={savedJob.id} />

        <Card>
          <CardTitle>Publish to the field</CardTitle>
          <CardDescription className="mt-1">
            {state === "published"
              ? "This job is live. Assigned field workers can see it. You can pull it back to a draft."
              : "Publishing flips the job from draft (office-only) to active, making it visible to assigned field workers."}
          </CardDescription>

          {publishError ? (
            <p
              role="alert"
              className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
            >
              {publishError}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {state === "published" ? (
              <Button
                data-testid="unpublish-to-draft"
                variant="secondary"
                disabled={busy !== null || dirty}
                onClick={() => runStatus("unpublish")}
              >
                <Undo2 className="h-4 w-4" aria-hidden="true" />
                {busy === "unpublish" ? "Unpublishing…" : "Unpublish (back to draft)"}
              </Button>
            ) : (
              <Button
                data-testid="publish-to-field"
                disabled={busy !== null || dirty || !ready}
                onClick={() => runStatus("publish")}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {busy === "publish" ? "Publishing…" : "Publish to field"}
              </Button>
            )}
            <Link
              href={`/v2/jobs/${encodeURIComponent(savedJob.id)}` as Route}
              className="text-sm text-text-muted underline decoration-border underline-offset-4 hover:text-text"
            >
              View job hub
            </Link>
          </div>
          {state !== "published" && !ready ? (
            <p className="mt-2 text-xs text-text-muted">
              Resolve the blocking issues above to enable publishing.
            </p>
          ) : null}
        </Card>
      </div>
    );
  }

  /* ============================ MORE (honest UC) ============================ */
  function renderMore() {
    return (
      <div className="space-y-4">
        <Card>
          <CardTitle>Not wired into the builder yet</CardTitle>
          <CardDescription className="mt-1">
            These belong to the job but aren&rsquo;t edited here. They&rsquo;re listed honestly so
            the builder doesn&rsquo;t look more complete than it is.
          </CardDescription>
          <ul className="mt-4 space-y-3">
            <MoreRow
              icon={FileText}
              title="Plans & documents"
              real="Read-only for now."
              body="The job view's Documents section shows the plans/specs already on the job. Uploading new plans (with revision / current / superseded state) was a legacy-only tool and was retired in the legacy cutover — a modern uploader is on the backlog. Builder-side attach/upload isn't wired."
            />
            <MoreRow
              icon={Package}
              title="Materials"
              real="Requests only for now."
              body="Field material requests have their own inbox under Material requests in the sidebar. Job materials (takeoff, POs, invoice match) were a legacy-only tool and were retired in the legacy cutover — a modern materials editor is on the backlog."
            />
            <MoreRow
              icon={HardHat}
              title="Labour allowances"
              real="Not implemented."
              body="There is no labour-allowance model on the job object today. Nothing here pretends to set one — it would need a data-model change first."
            />
            <MoreRow
              icon={Sparkles}
              title="Scope / PDF interpretation (AI)"
              real="Not connected for job structure."
              body="There is no engine that reads a scope/PDF and proposes a job structure. (Real AI does exist elsewhere — plan→material takeoff and tag OCR — but not scope→structure.) When/if it's built it'll be a reviewed-suggestion step, never an automatic write."
            />
            <MoreRow
              icon={ClipboardCheck}
              title="ITP / checkpoint requirements"
              real="Partial — toggle here, attach on the ITP surface."
              body="The ITP module toggle (Field modules tab) controls whether the field records ITPs. Attaching specific ITP templates to the job is handled on the ITP surface, not the builder."
            />
          </ul>
        </Card>
      </div>
    );
  }
}

/* ============================ pure helpers ============================ */

function tasksToForm(
  list: ReadonlyArray<{ id: string; name: string; archived?: boolean }> | undefined
): TaskRowForm[] {
  return (list ?? []).filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name }));
}

function jobToForm(job: Job): JobBuilderForm {
  const modules = {} as JobModules;
  for (const k of ALL_MODULE_KEYS) modules[k] = moduleEnabled(job, k);
  return {
    name: job.name ?? "",
    ref: job.ref ?? "",
    type: job.type ?? "",
    status: job.status ?? "active",
    clientUserId: job.clientUserId ?? "",
    siteAddress: job.siteAddress ?? "",
    siteContactName: job.siteContactName ?? "",
    siteContactPhone: job.siteContactPhone ?? "",
    accessNotes: job.accessNotes ?? "",
    parkingNotes: job.parkingNotes ?? "",
    safetyNotes: job.safetyNotes ?? "",
    inductionRequired: Boolean(job.inductionRequired),
    startDate: job.startDate ?? "",
    dueDate: job.dueDate ?? "",
    areaGroups: (job.areaGroups ?? [])
      .filter((g) => !g.archived)
      .map((g) => ({
        id: g.id,
        name: g.name,
        areas: (g.areas ?? [])
          .filter((a) => !a.archived)
          .map((a) => ({
            id: a.id,
            name: a.name,
            spaceType: a.spaceType ?? "",
            roughInTasks: tasksToForm(a.roughInTasks),
            fitOffTasks: tasksToForm(a.fitOffTasks),
          })),
      })),
    roughInTasks: tasksToForm(job.roughInTasks),
    fitOffTasks: tasksToForm(job.fitOffTasks),
    modules,
  };
}

function areaHasOverride(area: AreaRowForm): boolean {
  return Boolean((area.roughInTasks?.length ?? 0) || (area.fitOffTasks?.length ?? 0));
}

/**
 * #377 — read-only archived structure. The editable UI above never carries
 * archived items (the server is the retention authority); we still SHOW them so
 * an admin can see the full history honestly (P7). These rows are deliberately
 * muted, carry an "Archived" pill, and have NO inputs or remove buttons — never
 * a control that looks editable but no-ops. Renders nothing when nothing is
 * archived.
 */
export function ArchivedStructureSection({ archived }: { archived: ArchivedStructure }) {
  const { groups, areas, roughInTasks, fitOffTasks } = archived;
  const empty =
    groups.length === 0 &&
    areas.length === 0 &&
    roughInTasks.length === 0 &&
    fitOffTasks.length === 0;
  if (empty) return null;

  return (
    <Card data-testid="archived-structure" className="border-dashed bg-surface-subtle">
      <div className="flex items-center gap-2">
        <Archive className="h-5 w-5 text-text-muted" aria-hidden="true" />
        <CardTitle>Archived (read-only)</CardTitle>
      </div>
      <CardDescription className="mt-1">
        Archived rooms and tasks are kept for history and stay out of the field&rsquo;s view. They
        can&rsquo;t be edited here — adding and renaming the live structure above leaves them
        untouched.
      </CardDescription>

      {groups.length > 0 ? (
        <div className="mt-4">
          <p className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
            Area groups
          </p>
          <ul className="mt-2 space-y-2">
            {groups.map((g) => (
              <li
                key={g.id}
                data-testid="archived-group-row"
                className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm text-text-muted"
              >
                <span className="font-display font-semibold">{g.name}</span>
                <ArchivedPill />
                <span className="text-xs">
                  {g.liveAreaCount} live area{g.liveAreaCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {areas.length > 0 ? (
        <div className="mt-4">
          <p className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">Areas</p>
          <ul className="mt-2 space-y-2">
            {areas.map((a) => (
              <li
                key={a.id}
                data-testid="archived-area-row"
                className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm text-text-muted"
              >
                <span className="font-display font-semibold">{a.name}</span>
                {a.spaceType ? <span className="text-xs">({a.spaceType})</span> : null}
                <ArchivedPill />
                <span className="text-xs">in {a.groupName}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {roughInTasks.length > 0 || fitOffTasks.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {[
            { label: "Rough-in tasks", rows: roughInTasks },
            { label: "Fit-off tasks", rows: fitOffTasks },
          ]
            .filter((c) => c.rows.length > 0)
            .map((c) => (
              <div key={c.label}>
                <p className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
                  {c.label}
                </p>
                <ul className="mt-2 space-y-2">
                  {c.rows.map((t) => (
                    <li
                      key={t.id}
                      data-testid="archived-task-row"
                      className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm text-text-muted"
                    >
                      <span>{t.name}</span>
                      <ArchivedPill />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      ) : null}
    </Card>
  );
}

function ArchivedPill() {
  return (
    <Pill tone="neutral" className="text-[10px] uppercase tracking-wider">
      Archived
    </Pill>
  );
}

/* ============================ building blocks ============================ */

const inputClass =
  "w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-border-strong";

function Field({
  label,
  required,
  help,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-rose-600">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-[11px] text-text-muted">{help}</span>
      ) : null}
    </label>
  );
}

function MoreRow({
  icon: Icon,
  title,
  real,
  body,
}: {
  icon: typeof FileText;
  title: string;
  real: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded-card border border-border bg-surface p-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-sm font-semibold text-text">{title}</span>
          <Pill tone="neutral" className="text-[10px] uppercase tracking-wider">
            {real}
          </Pill>
        </div>
        <p className="mt-1 text-xs text-text-muted">{body}</p>
      </div>
    </li>
  );
}
