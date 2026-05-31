import {
  effectiveTasks,
  stageLabel,
  statusLabel,
  visibleAreaGroups,
} from "./format";
import type {
  Job,
  JobAreaGroupInput,
  JobAreaInput,
  JobCreateInput,
  JobModules,
  JobStage,
  JobStatus,
  JobTaskTemplateInput,
  JobUpdateInput,
} from "./types";

/**
 * Pure logic for the modern Job Builder/Editor. No fetch, no React — every
 * function here is a pure transform so it can be unit-tested without a
 * server (the api/*.js write handlers only run on a Vercel deploy, so the
 * payload shaping + publish rules are the part we CAN verify locally).
 *
 * Three jobs:
 *   1. Form → API payload (buildCreatePayload / buildUpdatePayload) —
 *      trims, drops blank rows, maps "clear this" to the value the server
 *      treats as a clear.
 *   2. Publish readiness (validateForPublish / canPublish) — the checklist
 *      the Publish tab runs. Grounded in what the job model ACTUALLY
 *      carries (basics + roughIn/fitOff task templates + areaGroups +
 *      modules); it deliberately does NOT invent checks for data the job
 *      object doesn't hold (documents, materials, labour, ITP requirements
 *      live on other blobs / surfaces and are labelled honestly in the UI).
 *   3. Phil preview (buildPhilPreview) — derives what an assigned field
 *      worker will see, from the real structure, reusing the same
 *      format.ts helpers the live Phil surface uses. Not hardcoded.
 *
 * Cross-ref:
 *   src/domains/jobs/format.ts — effectiveTasks / visibleAreaGroups / stageLabel
 *   api/jobs.js — POST create + PUT update (the real persistence)
 *   src/app/phil/jobs/[jobId]/page.tsx — the live surface this preview mirrors
 */

/* ---------------------------------------------------------------------
 * Module defaults — mirror api/jobs.js sanitizeModules().
 *
 * The base set defaults ON; the modular-concepts set (switchboards /
 * circuits / itps / levels) defaults OFF. Kept in sync with the server
 * by hand; the server remains authoritative.
 * -------------------------------------------------------------------*/

const MODULE_DEFAULT_TRUE: ReadonlyArray<keyof JobModules> = [
  "areas",
  "snags",
  "photos",
  "hours",
  "materials",
  "tags",
  "temps",
  "plans",
  "contacts",
];

/** Resolve a single module flag, applying the server's defaults so the
 *  preview matches what the field will actually see. */
export function moduleEnabled(job: Pick<Job, "modules">, key: keyof JobModules): boolean {
  const explicit = job.modules?.[key];
  if (typeof explicit === "boolean") return explicit;
  return MODULE_DEFAULT_TRUE.includes(key);
}

/* ---------------------------------------------------------------------
 * Publish state
 * -------------------------------------------------------------------*/

export type PublishState =
  | "draft"
  | "published"
  | "on_hold"
  | "complete"
  | "archived";

/** Map the raw status enum to a builder-facing publish state. A job with
 *  no status (legacy rows) reads as published — that matches format.ts's
 *  "Active" fallback and the fact those rows are already field-visible. */
export function publishState(job: Pick<Job, "status">): PublishState {
  const s: JobStatus = job.status ?? "active";
  if (s === "active") return "published";
  return s;
}

export function isDraft(job: Pick<Job, "status">): boolean {
  return (job.status ?? "active") === "draft";
}

export function isPublished(job: Pick<Job, "status">): boolean {
  return publishState(job) === "published";
}

/**
 * Whether assigned field workers can see this job. Mirrors the api/jobs.js
 * GET gate (draft is office-only) plus the list-surface archived filter.
 * Used by the preview banner so the admin knows whether "publish" is still
 * pending.
 */
export function isVisibleToField(job: Pick<Job, "status">): boolean {
  const s: JobStatus = job.status ?? "active";
  return s !== "draft" && s !== "archived";
}

/* ---------------------------------------------------------------------
 * Form model
 * -------------------------------------------------------------------*/

export interface TaskRowForm {
  id?: string;
  name: string;
}

export interface AreaRowForm {
  id?: string;
  name: string;
  spaceType?: string;
  roughInTasks?: TaskRowForm[];
  fitOffTasks?: TaskRowForm[];
}

export interface AreaGroupRowForm {
  id?: string;
  name: string;
  areas: AreaRowForm[];
}

/** Everything the full Builder/Editor workspace edits. */
export interface JobBuilderForm {
  name: string;
  ref: string;
  type: string;
  status: JobStatus;
  clientUserId: string;
  siteAddress: string;
  siteContactName: string;
  siteContactPhone: string;
  accessNotes: string;
  parkingNotes: string;
  safetyNotes: string;
  inductionRequired: boolean;
  startDate: string;
  dueDate: string;
  areaGroups: AreaGroupRowForm[];
  roughInTasks: TaskRowForm[];
  fitOffTasks: TaskRowForm[];
  modules: JobModules;
}

/** The minimal create form — a new job needs only a name; everything else
 *  is filled in afterwards in the Builder. */
export interface NewJobForm {
  name: string;
  ref?: string;
  type?: string;
  siteAddress?: string;
}

/* ---------------------------------------------------------------------
 * Form → payload
 * -------------------------------------------------------------------*/

function trimOrNull(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : null;
}

function cleanTasks(rows: ReadonlyArray<TaskRowForm> | undefined): JobTaskTemplateInput[] {
  if (!rows) return [];
  const out: JobTaskTemplateInput[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    out.push(r.id ? { id: r.id, name } : { name });
  }
  return out;
}

function cleanAreaGroups(
  groups: ReadonlyArray<AreaGroupRowForm> | undefined
): JobAreaGroupInput[] {
  if (!groups) return [];
  const out: JobAreaGroupInput[] = [];
  for (const g of groups) {
    const groupName = g.name.trim();
    if (!groupName) continue;
    const areas: JobAreaInput[] = [];
    for (const a of g.areas ?? []) {
      const areaName = a.name.trim();
      if (!areaName) continue;
      const area: JobAreaInput = a.id ? { id: a.id, name: areaName } : { name: areaName };
      const spaceType = (a.spaceType ?? "").trim();
      if (spaceType) area.spaceType = spaceType;
      const rough = cleanTasks(a.roughInTasks);
      if (rough.length) area.roughInTasks = rough;
      const fit = cleanTasks(a.fitOffTasks);
      if (fit.length) area.fitOffTasks = fit;
      areas.push(area);
    }
    out.push(g.id ? { id: g.id, name: groupName, areas } : { name: groupName, areas });
  }
  return out;
}

/** New-job create payload. New jobs start as 'draft' (office-only) so the
 *  draft → publish flip is a real visibility change, not decoration. */
export function buildCreatePayload(form: NewJobForm): JobCreateInput {
  const payload: JobCreateInput = {
    name: form.name.trim(),
    status: "draft",
  };
  const ref = (form.ref ?? "").trim();
  if (ref) payload.ref = ref;
  const type = (form.type ?? "").trim();
  if (type) payload.type = type;
  const siteAddress = (form.siteAddress ?? "").trim();
  if (siteAddress) payload.siteAddress = siteAddress;
  return payload;
}

/**
 * Full editor PUT payload. Sends every builder-managed field — these are
 * all fields the admin intentionally edits in the workspace, so a save is
 * the authoritative new state for them. Blank text basics are sent as ""
 * (the server stores the cleared value); type/client are sent as null to
 * clear. Money fields are intentionally absent so they're left untouched.
 */
export function buildUpdatePayload(jobId: string, form: JobBuilderForm): JobUpdateInput {
  return {
    id: jobId,
    name: form.name.trim(),
    status: form.status,
    ref: trimOrNull(form.ref),
    type: trimOrNull(form.type),
    clientUserId: trimOrNull(form.clientUserId),
    siteAddress: form.siteAddress.trim(),
    siteContactName: form.siteContactName.trim(),
    siteContactPhone: form.siteContactPhone.trim(),
    accessNotes: form.accessNotes.trim(),
    parkingNotes: form.parkingNotes.trim(),
    safetyNotes: form.safetyNotes.trim(),
    inductionRequired: form.inductionRequired,
    startDate: form.startDate.trim(),
    dueDate: form.dueDate.trim(),
    areaGroups: cleanAreaGroups(form.areaGroups),
    roughInTasks: cleanTasks(form.roughInTasks),
    fitOffTasks: cleanTasks(form.fitOffTasks),
    modules: form.modules,
  };
}

/* ---------------------------------------------------------------------
 * Structure summary (for the Job View hub + builder header)
 * -------------------------------------------------------------------*/

export interface StructureSummary {
  areaGroupCount: number;
  areaCount: number;
  roughInTaskCount: number;
  fitOffTaskCount: number;
  /** stages that have at least one (job-level or area-override) task */
  stagesWithTasks: JobStage[];
}

const STAGES: ReadonlyArray<JobStage> = ["roughIn", "fitOff"];

function jobLevelTasks(job: Job, stage: JobStage): ReadonlyArray<{ archived?: boolean }> {
  const list = stage === "roughIn" ? job.roughInTasks : job.fitOffTasks;
  return (list ?? []).filter((t) => !t.archived);
}

/** Does a stage have anything a worker would action — either a job-level
 *  template or a per-area override on at least one visible area? */
export function stageHasTasks(job: Job, stage: JobStage): boolean {
  if (jobLevelTasks(job, stage).length > 0) return true;
  const groups = visibleAreaGroups(job.areaGroups);
  for (const g of groups) {
    for (const a of g.areas ?? []) {
      if (effectiveTasks(job, a, stage).length > 0) return true;
    }
  }
  return false;
}

export function summariseStructure(job: Job): StructureSummary {
  const groups = visibleAreaGroups(job.areaGroups);
  const areaCount = groups.reduce((sum, g) => sum + (g.areas?.length ?? 0), 0);
  return {
    areaGroupCount: groups.length,
    areaCount,
    roughInTaskCount: jobLevelTasks(job, "roughIn").length,
    fitOffTaskCount: jobLevelTasks(job, "fitOff").length,
    stagesWithTasks: STAGES.filter((s) => stageHasTasks(job, s)),
  };
}

/* ---------------------------------------------------------------------
 * Publish readiness
 * -------------------------------------------------------------------*/

export type PublishSeverity = "error" | "warning";

export interface PublishIssue {
  code: string;
  message: string;
  severity: PublishSeverity;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The publish checklist. ERRORs block publish; WARNINGs are advisory and
 * shown but don't block. Scope is honest: only rules the job object can
 * actually answer. Document/material/labour/ITP/AI-suggestion checks are
 * NOT here because the job object doesn't carry that data — the UI labels
 * those surfaces explicitly rather than faking a green check.
 */
export function validateForPublish(job: Job): PublishIssue[] {
  const issues: PublishIssue[] = [];

  if (!job.name || !job.name.trim()) {
    issues.push({
      code: "name-missing",
      message: "Job needs a name before it can be published.",
      severity: "error",
    });
  }

  const tracksAreas = moduleEnabled(job, "areas");
  const groups = visibleAreaGroups(job.areaGroups);
  const areaCount = groups.reduce((sum, g) => sum + (g.areas?.length ?? 0), 0);
  const hasAnyTask = STAGES.some((s) => stageHasTasks(job, s));

  if (tracksAreas) {
    if (areaCount === 0) {
      issues.push({
        code: "no-areas",
        message:
          "This job tracks areas but has none. Add at least one area/zone, or turn the Areas module off if it genuinely has none.",
        severity: "error",
      });
    }
    if (!hasAnyTask) {
      issues.push({
        code: "no-tasks",
        message:
          "No rough-in or fit-off tasks defined. Add at least one task template (job-level or on an area) so the field has something to work.",
        severity: "error",
      });
    }
  }

  // Task name quality — blank names would render as empty rows for the field.
  const blankTask = STAGES.some((stage) =>
    (stage === "roughIn" ? job.roughInTasks : job.fitOffTasks)?.some(
      (t) => !t.archived && (!t.name || !t.name.trim())
    )
  );
  if (blankTask) {
    issues.push({
      code: "blank-task",
      message: "A task template has a blank name. Give every task a usable title.",
      severity: "error",
    });
  }

  // Dates — the server rejects an out-of-order pair on save, so this is a
  // defensive backstop. Reported as an error because it's a data fault.
  const start = (job.startDate ?? "").trim();
  const due = (job.dueDate ?? "").trim();
  if (start && due && DATE_RE.test(start) && DATE_RE.test(due) && start > due) {
    issues.push({
      code: "date-order",
      message: "Target date is before the start date.",
      severity: "error",
    });
  }

  // Advisory: a field crew almost always wants a site address.
  if (!(job.siteAddress ?? "").trim()) {
    issues.push({
      code: "no-site-address",
      message: "No site address set. The field crew won't have a location.",
      severity: "warning",
    });
  }

  return issues;
}

/** Publish is allowed when there are no error-severity issues. Warnings
 *  don't block. */
export function canPublish(issues: ReadonlyArray<PublishIssue>): boolean {
  return !issues.some((i) => i.severity === "error");
}

/* ---------------------------------------------------------------------
 * Phil preview — derived, never hardcoded
 * -------------------------------------------------------------------*/

export interface PhilPreviewStage {
  stage: JobStage;
  label: string;
  /** count of job-level templates for the stage (the default checklist) */
  jobLevelTaskCount: number;
}

export interface PhilPreviewArea {
  groupName: string;
  areaName: string;
  spaceType: string | null;
  roughInTasks: string[];
  fitOffTasks: string[];
}

export interface PhilPreviewSection {
  key: string;
  label: string;
  enabled: boolean;
}

export interface PhilPreview {
  jobName: string;
  ref: string | null;
  siteAddress: string | null;
  statusLabel: string;
  isVisibleToField: boolean;
  inductionRequired: boolean;
  stages: PhilPreviewStage[];
  areas: PhilPreviewArea[];
  sections: PhilPreviewSection[];
  /** Non-null when there's effectively nothing for the field to see yet. */
  emptyReason: string | null;
}

/**
 * Build the "what the field will see" preview straight from the job
 * structure, reusing the same effectiveTasks / visibleAreaGroups helpers
 * the live /phil/jobs/[jobId] surface uses. This is a faithful derivation,
 * not a mock — if the job has no structure, the preview says so.
 */
export function buildPhilPreview(job: Job): PhilPreview {
  const groups = visibleAreaGroups(job.areaGroups);

  const areas: PhilPreviewArea[] = [];
  for (const g of groups) {
    for (const a of g.areas ?? []) {
      areas.push({
        groupName: g.name,
        areaName: a.name,
        spaceType: (a.spaceType ?? "") || null,
        roughInTasks: effectiveTasks(job, a, "roughIn").map((t) => t.name),
        fitOffTasks: effectiveTasks(job, a, "fitOff").map((t) => t.name),
      });
    }
  }

  const stages: PhilPreviewStage[] = STAGES.filter((s) => stageHasTasks(job, s)).map(
    (stage) => ({
      stage,
      label: stageLabel(stage),
      jobLevelTaskCount: jobLevelTasks(job, stage).length,
    })
  );

  const sections: PhilPreviewSection[] = [
    { key: "photos", label: "Capture photos / evidence", enabled: moduleEnabled(job, "photos") },
    { key: "snags", label: "Raise snags", enabled: moduleEnabled(job, "snags") },
    { key: "itps", label: "Record ITPs", enabled: moduleEnabled(job, "itps") },
    { key: "plans", label: "View plans & documents", enabled: moduleEnabled(job, "plans") },
  ];

  const hasStructure = areas.length > 0 || stages.length > 0;
  const anySection = sections.some((s) => s.enabled);
  const emptyReason = !hasStructure
    ? anySection
      ? "No areas or tasks yet — the field would see the job header and the capture tools, but no work structure."
      : "Nothing to show yet — no areas, no tasks, and every field module is turned off."
    : null;

  return {
    jobName: job.name,
    ref: (job.ref ?? "") || null,
    siteAddress: (job.siteAddress ?? "") || null,
    statusLabel: statusLabel(job.status),
    isVisibleToField: isVisibleToField(job),
    inductionRequired: Boolean(job.inductionRequired),
    stages,
    areas,
    sections,
    emptyReason,
  };
}
