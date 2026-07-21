"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { effectiveTasks } from "@/domains/jobs/format";
import type { Job, JobArea } from "@/domains/jobs/types";
import {
  EMPTY_SELECTION,
  EVIDENCE_KIND_OPTIONS,
  FIELD_CLASSIFICATION_OPTIONS,
  STAGE_OPTIONS,
  buildReconciliationConfirmBody,
  canSave,
  compileConfirm,
  compilePreview,
  saveReconciliation,
  type AuthoringSelection,
  type AuthoringStage,
  type CompileConfirmData,
  type CompilePreviewData,
  type EvidenceKind,
  type FieldClassification,
  type ProofScope,
} from "./jobControlAuthoringClient";

/**
 * Admin required-proof authoring panel (the click-path that replaces DevTools
 * JSON). The flow reads top-to-bottom as one mental model:
 *
 *   Scope clause → worker task → required proof → compile for the field
 *
 * It is a thin shell over `jobControlAuthoringClient` (all logic + route calls
 * live there, unit-tested). Raw ids never appear as primary labels — clause
 * titles, area/task names and plain classification/proof labels do; the ids are
 * tucked in a "Developer details" foldout only.
 */
export function JobControlAuthoringPanel({ job }: { job: Job }) {
  const router = useRouter();
  const [sel, setSel] = useState<AuthoringSelection>(EMPTY_SELECTION);
  const [busy, setBusy] = useState<null | "save" | "preview" | "confirm">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<CompilePreviewData | null>(null);
  const [confirmed, setConfirmed] = useState<CompileConfirmData | null>(null);

  const clauses = job.scopeOfWork ?? [];
  const areas = useMemo(() => liveAreas(job), [job]);
  const selectedArea = areas.find((a) => a.id === sel.areaId) ?? null;
  const taskOptions =
    selectedArea && sel.stage
      ? effectiveTasks(job, selectedArea, sel.stage as AuthoringStage)
      : [];

  function update(patch: Partial<AuthoringSelection>) {
    // Any change to the selection invalidates the prior save/preview/compile —
    // each authoring round re-runs save → preview → compile for the current
    // intent, so the banners never refer to an edited-but-unsaved selection.
    setSel((s) => ({ ...s, ...patch }));
    setError(null);
    setSaved(false);
    setPreview(null);
    setConfirmed(null);
  }

  async function onSave() {
    if (!canSave(sel) || busy) return;
    setBusy("save");
    setError(null);
    const res = await saveReconciliation(job.id, sel);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setSaved(true);
    setPreview(null);
    setConfirmed(null);
  }

  async function onPreview() {
    if (busy) return;
    setBusy("preview");
    setError(null);
    const res = await compilePreview(job.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPreview(res.data);
  }

  async function onConfirm() {
    if (busy) return;
    setBusy("confirm");
    setError(null);
    const res = await compileConfirm(job.id, preview?.sourceHash ?? null);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setConfirmed(res.data);
    router.refresh();
  }

  if (clauses.length === 0) {
    return (
      <Card>
        <CardTitle>No scope clauses yet</CardTitle>
        <CardDescription className="mt-2">
          This job has no scope-of-work items, so there’s nothing to author proof
          against. Add scope in the job builder first, then come back here to set
          required proof for the field.
        </CardDescription>
      </Card>
    );
  }

  const saveReady = canSave(sel);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardTitle>Required proof for the field</CardTitle>
        <CardDescription className="mt-1">
          Pick a scope clause, tie it to the worker task that delivers it, name
          the proof the office needs, then compile it for the field. The worker then
          sees a “Capture proof” button on that task.
        </CardDescription>
        <p className="mt-2 text-xs text-text-muted">
          Scope clause → worker task → required proof → compile for the field
        </p>
      </Card>

      {/* 1 — scope clause */}
      <Card>
        <CardTitle>1. Scope clause</CardTitle>
        <CardDescription className="mt-1">
          The agreed scope item this proof belongs to.
        </CardDescription>
        <ul className="mt-3 space-y-2">
          {clauses.map((c) => (
            <li key={c.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-card border border-border p-3 hover:bg-surface-subtle">
                <input
                  type="radio"
                  name="clause"
                  className="mt-1"
                  checked={sel.clauseId === c.id}
                  onChange={() => update({ clauseId: c.id })}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-text">{c.title}</span>
                  {c.detail ? (
                    <span className="block text-sm text-text-muted">{c.detail}</span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>

      {/* 2 — classification + worker task */}
      <Card>
        <CardTitle>2. Worker task</CardTitle>
        <CardDescription className="mt-1">
          Classify the work and choose the existing area / stage / task that
          delivers it.
        </CardDescription>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Classification">
            <Select
              value={sel.classification}
              onChange={(v) => update({ classification: v as FieldClassification })}
              placeholder="Choose…"
              options={FIELD_CLASSIFICATION_OPTIONS}
            />
          </Field>
          <Field label="Area">
            <Select
              value={sel.areaId}
              onChange={(v) => update({ areaId: v, taskId: "" })}
              placeholder="Choose area…"
              options={areas.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field label="Stage">
            <Select
              value={sel.stage}
              onChange={(v) => update({ stage: v as AuthoringStage, taskId: "" })}
              placeholder="Choose stage…"
              options={STAGE_OPTIONS}
            />
          </Field>
          <Field label="Task">
            <Select
              value={sel.taskId}
              onChange={(v) => update({ taskId: v })}
              placeholder={selectedArea && sel.stage ? "Choose task…" : "Pick area + stage first"}
              options={taskOptions.map((t) => ({ value: t.id, label: t.name }))}
              disabled={!selectedArea || !sel.stage}
            />
          </Field>
        </div>
      </Card>

      {/* 3 — required proof */}
      <Card>
        <CardTitle>3. Required proof</CardTitle>
        <CardDescription className="mt-1">
          What the worker must capture. Use plain site language.
        </CardDescription>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Proof label">
            <input
              type="text"
              value={sel.proofLabel}
              onChange={(e) => update({ proofLabel: e.target.value })}
              placeholder="e.g. Photo of completed circuit"
              className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
            />
          </Field>
          <Field label="Proof type">
            <Select
              value={sel.proofKind}
              onChange={(v) => update({ proofKind: v as EvidenceKind })}
              options={EVIDENCE_KIND_OPTIONS}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Note (optional)">
              <input
                type="text"
                value={sel.proofNote}
                onChange={(e) => update({ proofNote: e.target.value })}
                placeholder="e.g. Capture after testing is complete"
                className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Applies to">
              <Select
                value={sel.proofScope}
                onChange={(v) => update({ proofScope: v as ProofScope })}
                options={[
                  { value: "area", label: "Whole area — every task here needs it" },
                  { value: "task", label: "Just this task" },
                ]}
              />
            </Field>
            <p className="mt-1 text-xs text-text-muted">
              Default keeps proof at the area level. Choose “Just this task” to ask for it on only the selected task.
            </p>
          </div>
        </div>
      </Card>

      {/* 4 — save → preview → compile for Phil */}
      <Card>
        <CardTitle>4. Compile for the field</CardTitle>
        <CardDescription className="mt-1">
          Save the proof, preview what will compile, then compile so it appears
          on the worker's phone.
        </CardDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={!saveReady || busy !== null}>
            {busy === "save" ? "Saving…" : "Save required proof"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onPreview} disabled={!saved || busy !== null}>
            {busy === "preview" ? "Previewing…" : "Preview compile"}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={!preview || busy !== null}>
            {busy === "confirm" ? "Compiling…" : "Compile for the field"}
          </Button>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-state-danger">
            {error}
          </p>
        ) : null}

        {saved && !confirmed ? (
          <p className="mt-3 text-sm text-state-success">
            Required proof saved. Preview, then compile for the field.
          </p>
        ) : null}

        {preview ? (
          <div className="mt-3 rounded-card border border-border bg-surface-subtle p-3 text-sm">
            <p className="font-medium text-text">Preview</p>
            <ul className="mt-1 space-y-0.5 text-text-muted">
              <li>Work packages: {preview.workPackageCount}</li>
              <li>Required proof items: {preview.requiredProofCount}</li>
              <li>
                Changes — added {preview.added}, updated {preview.updated}, removed{" "}
                {preview.removed}
              </li>
              <li>Gaps: {preview.gaps.length === 0 ? "none" : preview.gaps.length}</li>
            </ul>
            {preview.gaps.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-state-warning">
                {preview.gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {confirmed ? (
          <div className="mt-3 rounded-card border border-state-success/40 bg-surface-subtle p-3 text-sm" role="status">
            <p className="font-medium text-state-success">Compiled — proof will appear in the field app.</p>
            <ul className="mt-1 space-y-0.5 text-text-muted">
              <li>Work packages: {confirmed.workPackageCount}</li>
              <li>Gaps: {confirmed.gapCount}</li>
              <li className="break-all">Revision: {confirmed.revision}</li>
            </ul>
          </div>
        ) : null}
      </Card>

      {/* Developer foldout — raw ids only here, never as a primary label. */}
      <details className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
        <summary className="cursor-pointer select-none">Developer details</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(
            canSave(sel) ? buildReconciliationConfirmBody(job.id, sel) : { selection: sel },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}

/** Non-archived areas across all non-archived groups (the same set the field
 *  and the compiler see). */
function liveAreas(job: Job): JobArea[] {
  const out: JobArea[] = [];
  for (const group of job.areaGroups ?? []) {
    if (group.archived) continue;
    for (const area of group.areas ?? []) {
      if (area.archived) continue;
      out.push(area);
    }
  }
  return out;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
