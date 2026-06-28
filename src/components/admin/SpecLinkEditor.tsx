"use client";

import { useMemo, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { linkDocumentAreas } from "@/domains/documents/client";
import {
  DANGLING_AREA_LABEL,
  resolveAreaLinks,
  specStageLabel,
} from "@/domains/documents/format";
import { DOCUMENT_STAGES } from "@/domains/documents/schema";
import type { Document, DocumentStage } from "@/domains/documents/types";
import { visibleAreaGroups } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  jobId: string;
  /** The spec row being linked. */
  doc: Document;
  /** The live job (work tree) — drives the area picker + chip names. */
  job: Job;
}

/**
 * #196 — admin "Link areas / stage" control for a spec row.
 *
 * Renders the current linkage as chips (one per linked area; a dangling
 * link — area removed after linking — shows an honest "linked area no
 * longer on this job" warning chip, never a fabricated name, P7) plus a
 * stage chip when set. An expander reveals checkboxes for every live area
 * on the job and a stage selector; saving PATCHes /api/plans via the typed
 * wrapper (PUT-replace semantics). On success the row's linkage updates in
 * place from the server's denormalised response.
 *
 * Additive metadata on the existing register — no new uploader, no new
 * endpoint. Cross-ref: api/plans.js PATCH (#196), src/domains/documents.
 */
export function SpecLinkEditor({ jobId, doc, job }: Props) {
  // Local mirror of the spec's linkage so the chips update after a save
  // without a full page reload.
  const [areaIds, setAreaIds] = useState<ReadonlyArray<string>>(
    Array.isArray(doc.areaIds) ? doc.areaIds : [],
  );
  const [areaLinks, setAreaLinks] = useState<
    ReadonlyArray<{ areaId: string; areaName: string }>
  >(Array.isArray(doc.areaLinks) ? doc.areaLinks : []);
  const [stage, setStage] = useState<DocumentStage | "">(
    doc.stage === "roughIn" || doc.stage === "fitOff" ? doc.stage : "",
  );

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft state while the editor is open (committed on Save).
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [draftStage, setDraftStage] = useState<DocumentStage | "">("");

  // Live areas on the job (archived filtered out) — the source of truth
  // for the picker and for resolving chip names to CURRENT names.
  const liveAreas = useMemo(() => {
    const out: Array<{ id: string; name: string; groupName: string }> = [];
    for (const g of visibleAreaGroups(job.areaGroups)) {
      for (const a of g.areas ?? []) {
        out.push({ id: a.id, name: a.name, groupName: g.name });
      }
    }
    return out;
  }, [job.areaGroups]);

  const liveAreaNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of liveAreas) m.set(a.id, a.name);
    return m;
  }, [liveAreas]);

  const chips = useMemo(
    () => resolveAreaLinks({ areaIds, areaLinks }, liveAreaNames),
    [areaIds, areaLinks, liveAreaNames],
  );

  function openEditor() {
    setDraftIds(new Set(areaIds));
    setDraftStage(stage);
    setError(null);
    setOpen(true);
  }

  function toggleDraft(id: string) {
    setDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const nextIds = [...draftIds];
    const result = await linkDocumentAreas(jobId, doc.id, {
      areaIds: nextIds,
      stage: draftStage === "" ? null : draftStage,
    });
    setSaving(false);
    if (!result.ok) {
      setError(
        result.error.status === 400
          ? "One of those areas is no longer on this job. Refresh and try again."
          : "Couldn’t save the link. Try again in a moment.",
      );
      return;
    }
    const plan = result.data.plan;
    setAreaIds(Array.isArray(plan.areaIds) ? plan.areaIds : []);
    setAreaLinks(Array.isArray(plan.areaLinks) ? plan.areaLinks : []);
    setStage(
      plan.stage === "roughIn" || plan.stage === "fitOff" ? plan.stage : "",
    );
    setOpen(false);
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.length === 0 && !stage ? (
          <span className="text-xs text-text-muted">Not linked to any area</span>
        ) : (
          <>
            {chips.map((c) =>
              c.live ? (
                <Pill key={c.areaId} tone="info">
                  {c.name}
                </Pill>
              ) : (
                <Pill key={c.areaId} tone="warning" title={DANGLING_AREA_LABEL}>
                  {DANGLING_AREA_LABEL}
                </Pill>
              ),
            )}
            {stage ? <Pill tone="neutral">{specStageLabel(stage)}</Pill> : null}
          </>
        )}
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openEditor())}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
          Link areas / stage
        </button>
      </div>

      {open ? (
        <div className="mt-2 rounded-card border border-border bg-surface-subtle p-3">
          {liveAreas.length === 0 ? (
            <p className="text-xs text-text-muted">
              This job has no areas yet. Add areas in the job builder, then link
              the spec.
            </p>
          ) : (
            <fieldset>
              <legend className="font-display text-xs uppercase tracking-wider text-text-muted">
                Areas this spec governs
              </legend>
              <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {liveAreas.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-2 text-sm text-text">
                      <input
                        type="checkbox"
                        checked={draftIds.has(a.id)}
                        onChange={() => toggleDraft(a.id)}
                        className="h-4 w-4 rounded border-border"
                      />
                      <span className="min-w-0 truncate">
                        {a.name}
                        <span className="text-text-muted"> · {a.groupName}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}

          <div className="mt-3">
            <span className="font-display text-xs uppercase tracking-wider text-text-muted">
              Stage (optional)
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup">
              <StageChip
                label="Both"
                active={draftStage === ""}
                onClick={() => setDraftStage("")}
              />
              {DOCUMENT_STAGES.map((s) => (
                <StageChip
                  key={s}
                  label={specStageLabel(s)}
                  active={draftStage === s}
                  onClick={() => setDraftStage(s)}
                />
              ))}
            </div>
          </div>

          {error ? (
            <p className="mt-2 text-xs text-state-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex h-8 items-center gap-2 rounded-card border border-brand-navy bg-brand-navy px-3 text-sm font-medium text-text-inverse transition-colors hover:bg-brand-navy/90 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : null}
              Save link
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={saving}
              className="inline-flex h-8 items-center rounded-card border border-border bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-surface-subtle disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StageChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "rounded-pill border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
      )}
    >
      {label}
    </button>
  );
}
