"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { createSnag } from "@/domains/snags/client";
import {
  SNAG_DESCRIPTION_MAX,
  SNAG_EVIDENCE_LINK_MAX,
  SNAG_PRIORITIES,
  SNAG_TITLE_MAX,
} from "@/domains/snags/schema";
import { priorityLabel } from "@/domains/snags/format";
import type {
  CreateSnagPayload,
  SnagItem,
  SnagPriority,
} from "@/domains/snags/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job, JobStage } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";
import { visibleAreaGroups } from "@/domains/jobs/format";

interface Props {
  open: boolean;
  job: Job;
  /** Context inherited from the page — stage + areaId are the area
   *  the worker was already looking at. Either may be null. */
  initialContext: { stage: JobStage | null; areaId: string | null };
  /** Worker's recent evidence captures on this job — the sheet
   *  offers a multi-select to link supporting evidence. May be empty. */
  recentEvidence?: ReadonlyArray<EvidenceItem>;
  onClose: () => void;
  onCreated: (item: SnagItem) => void;
  onFailed: (message: string) => void;
}

/**
 * Phil — Report snag sheet (Phase D.5).
 *
 * Full-screen on mobile, modal on desktop. Hosts a single short form:
 *
 *   1. Title           required, ≤ SNAG_TITLE_MAX, large input
 *   2. Description     optional, ≤ SNAG_DESCRIPTION_MAX, textarea
 *   3. Priority        4-button grid (Low / Normal / High / Urgent)
 *   4. Area            inherits from page; optional override picker
 *   5. Evidence links  multi-select chips of own recent captures
 *   6. Submit          large primary CTA; disables while in-flight
 *
 * Mirrors CaptureSheet's shape so the muscle memory between
 * "capture evidence" and "report snag" is identical. Cross-ref:
 *   src/components/phil/CaptureSheet.tsx — precedent
 */
export function ReportSnagSheet({
  open,
  job,
  initialContext,
  recentEvidence = [],
  onClose,
  onCreated,
  onFailed,
}: Props) {
  const groups = useMemo(() => visibleAreaGroups(job.areaGroups), [job.areaGroups]);
  const flatAreas = useMemo(
    () =>
      groups.flatMap((g) =>
        (g.areas ?? []).map((a) => ({ ...a, groupName: g.name }))
      ),
    [groups]
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<SnagPriority>("normal");
  const [areaId, setAreaId] = useState<string | null>(initialContext.areaId ?? null);
  const [stage, setStage] = useState<JobStage | null>(initialContext.stage ?? null);
  const [linkedEvidenceIds, setLinkedEvidenceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-seed the form whenever the sheet opens so a previous open-close
  // doesn't leak state into the next session. The page's selected
  // stage/area carries through as the default context.
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setPriority("normal");
      setAreaId(initialContext.areaId ?? null);
      setStage(initialContext.stage ?? null);
      setLinkedEvidenceIds([]);
      setBusy(false);
      setErrorMessage(null);
    }
  }, [open, initialContext.areaId, initialContext.stage]);

  // Esc closes the sheet — matches CaptureSheet UX.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const titleTrimmed = title.trim();
  const submitDisabled =
    busy || titleTrimmed.length === 0 || titleTrimmed.length > SNAG_TITLE_MAX;

  const toggleLink = useCallback((id: string) => {
    setLinkedEvidenceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitDisabled) return;
    setBusy(true);
    setErrorMessage(null);
    const payload: CreateSnagPayload = {
      title: titleTrimmed,
      description: description.trim() ? description.trim() : null,
      priority,
      areaId: areaId || null,
      stage: areaId && stage ? stage : null,
      evidenceIds: linkedEvidenceIds.length ? linkedEvidenceIds : undefined,
    };
    const r = await createSnag(job.id, payload);
    setBusy(false);
    if (r.ok) {
      onCreated(r.data.snagItem);
      onClose();
    } else {
      const message =
        r.error.status === 403
          ? "You don't have access to raise a snag on this job."
          : r.error.status === 400
            ? typeof r.error.body === "object" &&
              r.error.body !== null &&
              "error" in r.error.body
              ? String((r.error.body as { error: string }).error)
              : "Couldn't save snag — check the form and try again."
            : r.error.message || "Couldn't save snag. Try again.";
      setErrorMessage(message);
      onFailed(message);
    }
  }, [
    submitDisabled,
    titleTrimmed,
    description,
    priority,
    areaId,
    stage,
    linkedEvidenceIds,
    job.id,
    onCreated,
    onClose,
    onFailed,
  ]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Report snag"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-accent-ink/40"
    >
      <div className="flex h-full w-full flex-col bg-surface sm:my-6 sm:h-auto sm:max-w-lg sm:rounded-card sm:shadow-raised">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-5 w-5 text-state-warning" />
            <h2 className="font-display text-lg text-text">Report snag</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle disabled:opacity-50"
            aria-label="Close"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <Field label="What's the problem?" required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={SNAG_TITLE_MAX}
              placeholder="Short title — e.g. Plug missing earth"
              className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base text-text outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20"
            />
            <Counter value={title.length} max={SNAG_TITLE_MAX} />
          </Field>

          <Field label="Notes (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={SNAG_DESCRIPTION_MAX}
              rows={4}
              placeholder="What was wrong? Where exactly? Any safety implications?"
              className="w-full rounded-card border border-border bg-surface p-3 text-base text-text outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20"
            />
            <Counter value={description.length} max={SNAG_DESCRIPTION_MAX} />
          </Field>

          <Field label="Priority">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Priority">
              {SNAG_PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={priority === p}
                  onClick={() => setPriority(p)}
                  className={cn(
                    "rounded-card border px-3 py-3 text-center font-display text-sm font-semibold transition-colors",
                    priority === p
                      ? "border-brand-navy bg-brand-navy text-text-inverse"
                      : "border-border bg-surface text-text hover:bg-surface-subtle"
                  )}
                >
                  {priorityLabel(p)}
                </button>
              ))}
            </div>
          </Field>

          {flatAreas.length > 0 ? (
            <Field label="Area (optional)">
              <select
                value={areaId ?? ""}
                onChange={(e) => setAreaId(e.target.value || null)}
                className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base text-text outline-none focus:border-brand-navy"
              >
                <option value="">— No specific area —</option>
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {(g.areas ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
          ) : null}

          {recentEvidence.length > 0 ? (
            <Field label="Link evidence (optional)">
              <p className="text-xs text-text-muted">
                Tap to attach captures that show this snag.
              </p>
              <ul className="mt-2 grid gap-2">
                {recentEvidence.slice(0, SNAG_EVIDENCE_LINK_MAX).map((ev) => {
                  const linked = linkedEvidenceIds.includes(ev.id);
                  const atCap =
                    !linked && linkedEvidenceIds.length >= SNAG_EVIDENCE_LINK_MAX;
                  return (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() => toggleLink(ev.id)}
                        aria-pressed={linked}
                        disabled={atCap}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-card border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          linked
                            ? "border-brand-navy bg-brand-navy/5"
                            : "border-border bg-surface hover:bg-surface-subtle"
                        )}
                      >
                        {ev.kind === "photo" && ev.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={ev.photoUrl}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded-card object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="h-10 w-10 shrink-0 rounded-card bg-surface-subtle" />
                        )}
                        <span className="min-w-0 flex-1 text-sm">
                          <span className="block truncate text-text">
                            {ev.note ?? "(no note)"}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {ev.kind === "photo" ? "Photo" : "Note"}
                          </span>
                        </span>
                        {linked ? (
                          <span className="text-xs font-semibold text-brand-navy">
                            Linked
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Field>
          ) : null}

          {errorMessage ? (
            <div
              role="alert"
              className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
            >
              {errorMessage}
            </div>
          ) : null}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="primary"
            size="lg"
            disabled={submitDisabled}
            onClick={handleSubmit}
            className="w-full bg-accent-yellow text-brand-navy hover:bg-accent-yellow"
          >
            {busy ? "Saving…" : "Report snag"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-display text-sm font-semibold text-text">
        {label}
        {required ? <span className="ml-1 text-state-danger">*</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  const close = value >= max - 20;
  return (
    <p
      className={cn(
        "mt-1 text-right text-xs",
        close ? "text-state-warning" : "text-text-muted"
      )}
    >
      {value}/{max}
    </p>
  );
}
