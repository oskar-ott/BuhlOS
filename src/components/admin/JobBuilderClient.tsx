"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import Link from "next/link";
import {
  AlertTriangle,
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
  Plus,
  Save,
  Send,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { publishJob, unpublishJob, updateJob } from "@/domains/jobs/client";
import {
  buildPhilPreview,
  buildUpdatePayload,
  canPublish,
  isVisibleToField,
  moduleEnabled,
  publishState,
  summariseStructure,
  validateForPublish,
  type AreaRowForm,
  type JobBuilderForm,
  type TaskRowForm,
} from "@/domains/jobs/builder";
import { validateJobBasics } from "@/domains/jobs/validate";
import { statusLabel, statusTone } from "@/domains/jobs/format";
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
 *   - Structure editing is frozen (read-only) when the job carries archived
 *     rooms/tasks, because api/jobs.js PUT replaces the structure wholesale
 *     and would corrupt those archived items. Such jobs are edited on the
 *     legacy structure editor; we say so rather than risk data loss.
 *
 * Cross-ref:
 *   src/domains/jobs/builder.ts — payload + publish + preview logic (tested)
 *   src/domains/jobs/client.ts — updateJob / publishJob / unpublishJob
 *   api/jobs.js — PUT (update) + the draft GET gate
 */

type TabKey = "basics" | "structure" | "modules" | "preview" | "publish" | "more";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basics", label: "Basics" },
  { key: "structure", label: "Structure" },
  { key: "modules", label: "Field modules" },
  { key: "preview", label: "Phil preview" },
  { key: "publish", label: "Publish" },
  { key: "more", label: "More" },
];

/** Field-facing module toggles, in display order. Other module keys
 *  (switchboards / circuits / levels) round-trip untouched — they're
 *  advanced structural concepts, not field on/off switches. */
const MODULE_TOGGLES: ReadonlyArray<{ key: keyof JobModules; label: string; help: string }> = [
  { key: "areas", label: "Areas / zones", help: "Track work by room/zone. Off = a flat job with no area breakdown." },
  { key: "photos", label: "Photo evidence", help: "Field can capture photo/note evidence against tasks." },
  { key: "snags", label: "Snags / defects", help: "Field can raise defects for the office to action." },
  { key: "itps", label: "ITP / QA records", help: "Field records inspection & test points for sign-off." },
  { key: "plans", label: "Plans & documents", help: "Field can view plans/specs attached to the job." },
  { key: "materials", label: "Materials list", help: "Field can see the job materials list." },
  { key: "hours", label: "Log hours", help: "Field can log hours against this job." },
  { key: "tags", label: "Test tags", help: "Field can record test-and-tag entries." },
  { key: "temps", label: "Temperature logs", help: "Field can record temperature readings." },
  { key: "contacts", label: "Site contacts", help: "Show site contact details to the field." },
];

const ALL_MODULE_KEYS: ReadonlyArray<keyof JobModules> = [
  "areas", "snags", "photos", "hours", "materials", "tags", "temps", "plans",
  "contacts", "switchboards", "circuits", "itps", "levels",
];

const STAGES: ReadonlyArray<{ stage: JobStage; label: string }> = [
  { stage: "roughIn", label: "Rough-in tasks" },
  { stage: "fitOff", label: "Fit-off tasks" },
];

export function JobBuilderClient({ job: initialJob }: { job: Job }) {
  const router = useRouter();
  const [savedJob, setSavedJob] = useState<Job>(initialJob);
  const [form, setForm] = useState<JobBuilderForm>(() => jobToForm(initialJob));
  const [tab, setTab] = useState<TabKey>("basics");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [busy, setBusy] = useState<null | "publish" | "unpublish">(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const structureFrozen = useMemo(() => hasArchivedStructure(savedJob), [savedJob]);

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

  async function save() {
    if (!basicsValid) {
      setTab("basics");
      return;
    }
    setSaving(true);
    setSaveError(null);
    const payload = buildUpdatePayload(savedJob.id, form);
    // Structure is frozen for jobs with archived rooms/tasks — never send
    // the structure arrays (the PUT replaces them wholesale and would drop
    // the archived items). Basics + modules + status still save.
    if (structureFrozen) {
      delete payload.areaGroups;
      delete payload.roughInTasks;
      delete payload.fitOffTasks;
    }
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

  async function runStatus(action: "publish" | "unpublish") {
    setBusy(action);
    setPublishError(null);
    const res = await (action === "publish"
      ? publishJob(savedJob.id)
      : unpublishJob(savedJob.id));
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
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Office-only (not yet published)
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button onClick={save} disabled={!dirty || saving || !basicsValid}>
              <Save className="h-4 w-4" aria-hidden="true" />
              {saving ? "Saving…" : dirty ? "Save changes" : savedTick ? "Saved ✓" : "Saved"}
            </Button>
            <span className="text-[11px] uppercase tracking-wider text-text-muted">
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

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Job builder sections"
        className="flex flex-wrap gap-1 rounded-card border border-border bg-surface p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-card px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-brand-navy text-text-inverse"
                : "text-text-muted hover:bg-surface-subtle hover:text-text"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "basics" ? renderBasics() : null}
      {tab === "structure" ? renderStructure() : null}
      {tab === "modules" ? renderModules() : null}
      {tab === "preview" ? renderPreview() : null}
      {tab === "publish" ? renderPublish() : null}
      {tab === "more" ? renderMore() : null}
    </div>
  );

  /* ============================ BASICS ============================ */
  function renderBasics() {
    return (
      <Card>
        <CardTitle>Basics</CardTitle>
        <CardDescription className="mt-1">
          The job header and site context. Name is required; everything else
          is optional and can be filled in over time.
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
            <input className={inputClass} value={form.ref} onChange={(e) => set("ref", e.target.value)} />
          </Field>
          <Field label="Job type" help="Type is managed on the legacy job admin.">
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
            <span className="text-sm text-text">Site induction required before the crew attends</span>
          </label>
        </div>
      </Card>
    );
  }

  /* ============================ STRUCTURE ============================ */
  function renderStructure() {
    if (structureFrozen) {
      const s = summariseStructure(savedJob);
      return (
        <Card>
          <div className="flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-display font-semibold">Structure editing is on the legacy editor for this job</p>
              <p className="mt-1 text-xs">
                This job has archived rooms or tasks. The modern builder saves
                structure as a whole, which would disturb those archived items,
                so structure for jobs like this is edited on the legacy{" "}
                <a
                  href="/admin/jobs.html"
                  className="underline decoration-amber-400 underline-offset-2"
                >
                  /admin/jobs
                </a>{" "}
                editor. Basics, field modules, and publishing still work here.
              </p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Area groups" value={s.areaGroupCount} />
            <Stat label="Areas" value={s.areaCount} />
            <Stat label="Rough-in tasks" value={s.roughInTaskCount} />
            <Stat label="Fit-off tasks" value={s.fitOffTaskCount} />
          </dl>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        <Card>
          <CardTitle>Task templates</CardTitle>
          <CardDescription className="mt-1">
            The default rough-in and fit-off checklist every area inherits.
            Stages are fixed (rough-in → fit-off). An area can override these
            with its own list in the legacy editor.
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
                Group the job into areas the field works against (e.g. Level 1 →
                Unit 1). Leave empty for a flat job, or turn off the Areas module.
              </CardDescription>
            </div>
            <Button size="sm" variant="secondary" onClick={addGroup}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Group
            </Button>
          </div>

          {form.areaGroups.length === 0 ? (
            <p className="mt-4 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-6 text-center text-sm text-text-muted">
              No areas yet. Add a group to start, or keep it flat and define work
              with the task templates above.
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
                    <Button size="sm" variant="ghost" onClick={() => removeGroup(gi)} aria-label="Remove group">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2 pl-1">
                    {group.areas.map((area, ai) => (
                      <li key={ai} className="flex flex-wrap items-center gap-2">
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
                          onClick={() => removeArea(gi, ai)}
                          aria-label="Remove area"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => addArea(gi)}>
                    <Plus className="h-4 w-4" aria-hidden="true" /> Area
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
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
                  onClick={() => setJobTasks(stage, rows.filter((_, i) => i !== idx))}
                  aria-label="Remove task"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
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

  /* area-group / area mutators */
  function addGroup() {
    set("areaGroups", [...form.areaGroups, { name: "", areas: [] }]);
  }
  function removeGroup(gi: number) {
    set("areaGroups", form.areaGroups.filter((_, i) => i !== gi));
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
          What the field crew can do on this job. Turning a module off hides it
          from the Phil app for this job (it doesn&rsquo;t delete any data).
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
              This preview reflects the <strong>last saved</strong> version. Save
              your changes to see them here and in what the field gets.
            </span>
          </div>
        ) : null}
        <Card>
          <div className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-text-muted" aria-hidden="true" />
            <CardTitle>What the field will see</CardTitle>
          </div>
          <CardDescription className="mt-1">
            Derived from the saved job structure — the same data the Phil app
            renders. Not a mock.
          </CardDescription>

          <div className="mt-3 rounded-card border border-border bg-surface p-3">
            <p className="font-display text-base font-semibold text-text">{preview.jobName}</p>
            <p className="text-sm text-text-muted">
              {[preview.ref && `Ref ${preview.ref}`, preview.siteAddress].filter(Boolean).join(" · ") || "No ref or address yet"}
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
                  <p className="font-display text-xs uppercase tracking-wider text-text-muted">Stages</p>
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
                    <li key={i} className="rounded-card border border-border bg-surface p-3 text-sm">
                      <p className="font-display font-semibold text-text">
                        {a.groupName} · {a.areaName}
                        {a.spaceType ? <span className="ml-1 text-text-muted">({a.spaceType})</span> : null}
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
            <p className="font-display text-xs uppercase tracking-wider text-text-muted">Field tools</p>
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
            Checks run against the <strong>saved</strong> job. Errors block
            publishing; warnings are advisory.
          </CardDescription>

          {dirty ? (
            <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You have unsaved changes. Save first — publishing only writes the
              status, so unsaved edits wouldn&rsquo;t be included.
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
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {i.message}
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
                variant="secondary"
                disabled={busy !== null || dirty}
                onClick={() => runStatus("unpublish")}
              >
                <Undo2 className="h-4 w-4" aria-hidden="true" />
                {busy === "unpublish" ? "Unpublishing…" : "Unpublish (back to draft)"}
              </Button>
            ) : (
              <Button
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
            These belong to the job but aren&rsquo;t edited here. They&rsquo;re
            listed honestly so the builder doesn&rsquo;t look more complete than
            it is. Where a real surface exists, the link goes to it.
          </CardDescription>
          <ul className="mt-4 space-y-3">
            <MoreRow
              icon={FileText}
              title="Plans & documents"
              real="Real — on the legacy plans surface."
              body="Uploading plans/specs (with revision / current / superseded state) runs on /admin/plans, including a real AI plan→material takeoff. The job view's Documents section reads that index. Builder-side attach/upload isn't wired."
              legacyHref="/admin/plans"
              legacyLabel="Open /admin/plans"
            />
            <MoreRow
              icon={Package}
              title="Materials"
              real="Real — on the legacy materials surface."
              body="Job materials (takeoff, POs, invoice match) live on /admin/materials. A builder-side materials editor isn't wired; the job view shows Materials as under construction."
              legacyHref="/admin/materials"
              legacyLabel="Open /admin/materials"
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

function tasksToForm(list: ReadonlyArray<{ id: string; name: string; archived?: boolean }> | undefined): TaskRowForm[] {
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

function hasArchivedStructure(job: Job): boolean {
  const groups = job.areaGroups ?? [];
  if (groups.some((g) => g.archived)) return true;
  for (const g of groups) {
    for (const a of g.areas ?? []) {
      if (a.archived) return true;
      if ((a.roughInTasks ?? []).some((t) => t.archived)) return true;
      if ((a.fitOffTasks ?? []).some((t) => t.archived)) return true;
    }
  }
  if ((job.roughInTasks ?? []).some((t) => t.archived)) return true;
  if ((job.fitOffTasks ?? []).some((t) => t.archived)) return true;
  return false;
}

function areaHasOverride(area: AreaRowForm): boolean {
  return Boolean((area.roughInTasks?.length ?? 0) || (area.fitOffTasks?.length ?? 0));
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-display text-lg text-text">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function MoreRow({
  icon: Icon,
  title,
  real,
  body,
  legacyHref,
  legacyLabel,
}: {
  icon: typeof FileText;
  title: string;
  real: string;
  body: string;
  legacyHref?: string;
  legacyLabel?: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded-card border border-border bg-surface p-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-sm font-semibold text-text">{title}</span>
          <Pill tone="neutral" className="text-[10px] uppercase tracking-wider">{real}</Pill>
        </div>
        <p className="mt-1 text-xs text-text-muted">{body}</p>
        {legacyHref && legacyLabel ? (
          <a
            href={legacyHref}
            className="mt-1 inline-block text-xs underline decoration-accent-yellow underline-offset-4 hover:text-brand-navy"
          >
            {legacyLabel}
          </a>
        ) : null}
      </div>
    </li>
  );
}
