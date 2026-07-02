"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import {
  PHOTO_LABEL_TAXONOMY,
  hasVisibleLabel,
  isUnlabelled,
} from "@/domains/evidence/labels";
import { EVIDENCE_STAGES } from "@/domains/evidence/schema";
import { stageLabel } from "@/domains/evidence/format";
import { photoLabelDisplay } from "./EvidenceLabelChips";
import type {
  EvidenceItem,
  EvidenceStage,
  ServerEvidenceStatus,
} from "@/domains/evidence/types";
import { visibleAreaGroups } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

export type StatusFilter = "all" | ServerEvidenceStatus;

/**
 * Sentinel for the "captured with no area" axis (#260). Distinct from
 * `unattachedOnly` (which means no stage AND no area AND no task) — this one
 * means specifically "areaId is null", regardless of stage/task. The two
 * untagged axes are labelled distinctly in the UI so they don't read as
 * duplicates (AC5).
 */
export const NO_AREA = "__none__";

/**
 * Sentinel for the "no visible labels" axis (#262). Follows the NO_AREA
 * idiom: null = any; NO_LABELS = isUnlabelled(item); otherwise a taxonomy
 * label matched via hasVisibleLabel. "No labels" is a normal, honest state
 * — filterable, never spoofed.
 */
export const NO_LABELS = "__unlabelled__";

export interface FilterState {
  status: StatusFilter;
  capturedById: string | null;
  unattachedOnly: boolean;
  fromDate: string | null; // YYYY-MM-DD
  toDate: string | null;   // YYYY-MM-DD
  /** Area context filter (#260). null = any area; NO_AREA = no area at all;
   *  otherwise an areaId. AND-combines with the other filters. */
  areaId: string | null;
  /** Stage context filter (#260). null = any stage. */
  stage: EvidenceStage | null;
  /** Task context filter (#260). null = any task; an exact taskId otherwise. */
  taskId: string | null;
  /** Label filter (#262). null = any; NO_LABELS = no visible labels;
   *  otherwise a PHOTO_LABEL_TAXONOMY label. AND-combines with the rest. */
  label: string | null;
}

export const DEFAULT_FILTER: FilterState = {
  status: "submitted",
  capturedById: null,
  unattachedOnly: false,
  fromDate: null,
  toDate: null,
  areaId: null,
  stage: null,
  taskId: null,
  label: null,
};

/** A selectable area in the context filter. `archived` flags areas referenced
 *  by loaded rows but no longer visible in the job structure — so every
 *  visible row stays reachable and "showing N of M" reconciles (#260). */
export interface AreaOption {
  id: string;
  name: string;
  archived: boolean;
}

/**
 * Build the area-filter option list (#260): the union of the job's VISIBLE
 * areas plus any areaId referenced by a loaded row that isn't visible (labelled
 * "(archived)"). Pure + exported so the predicate matrix and the option list
 * are both unit-testable. Names resolve via the areaGroups walk; an unknown id
 * falls back to the raw id.
 */
export function buildAreaOptions(
  job: Pick<Job, "areaGroups">,
  items: ReadonlyArray<Pick<EvidenceItem, "areaId">>
): AreaOption[] {
  const out: AreaOption[] = [];
  const seen = new Set<string>();

  for (const group of visibleAreaGroups(job.areaGroups)) {
    for (const area of group.areas ?? []) {
      if (!area || seen.has(area.id)) continue;
      seen.add(area.id);
      out.push({ id: area.id, name: area.name?.trim() || area.id, archived: false });
    }
  }

  // Resolve names for any area still present in the raw structure (archived).
  const rawNames = new Map<string, string>();
  for (const group of job.areaGroups ?? []) {
    for (const area of group.areas ?? []) {
      if (area && !rawNames.has(area.id)) rawNames.set(area.id, area.name?.trim() || area.id);
    }
  }

  for (const it of items) {
    const id = it.areaId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: rawNames.get(id) || id, archived: true });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface Props {
  /** The job — resolves area ids to the names the boss authored (#260). */
  job: Pick<Job, "areaGroups">;
  items: ReadonlyArray<EvidenceItem>;
  value: FilterState;
  onChange: (next: FilterState) => void;
  /** Visible row count after the filter is applied. Drives the "showing N
   *  of M" copy in the bar. */
  visibleCount: number;
  /** #262 — true when the viewer is an admin AND the ai_photo_labels flag
   *  is on. The Label filter axis doesn't render at all otherwise — the
   *  feature stays dark. */
  aiLabelsEnabled?: boolean;
}

/**
 * Filter bar above the evidence queue (doc 30 §6.4).
 *
 * Filters are pure UI state — the server returns all evidence the role
 * can see; the bar narrows the visible list client-side. The
 * `capturedBy` dropdown only lists workers who actually have captures
 * in the current dataset.
 *
 * The status dropdown defaults to `submitted` so the queue surfaces
 * pending review first — admin's primary attention target.
 */
export function EvidenceFilterBar({
  job,
  items,
  value,
  onChange,
  visibleCount,
  aiLabelsEnabled = false,
}: Props) {
  const captureBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of items) {
      if (it.capturedById && !map.has(it.capturedById)) {
        map.set(it.capturedById, it.capturedByName || it.capturedById);
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const areaOptions = useMemo(() => buildAreaOptions(job, items), [job, items]);

  const isDefault =
    value.status === DEFAULT_FILTER.status &&
    value.capturedById === DEFAULT_FILTER.capturedById &&
    value.unattachedOnly === DEFAULT_FILTER.unattachedOnly &&
    value.fromDate === DEFAULT_FILTER.fromDate &&
    value.toDate === DEFAULT_FILTER.toDate &&
    value.areaId === DEFAULT_FILTER.areaId &&
    value.stage === DEFAULT_FILTER.stage &&
    value.taskId === DEFAULT_FILTER.taskId &&
    value.label === DEFAULT_FILTER.label;

  return (
    <div className="rounded-card border border-border bg-surface-raised p-3 shadow-card">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label="Status">
          <select
            value={value.status}
            onChange={(e) =>
              onChange({ ...value, status: e.target.value as StatusFilter })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="all">All</option>
            <option value="submitted">Submitted</option>
            <option value="reviewed">Reviewed</option>
            <option value="rejected">Rejected</option>
          </select>
        </FilterField>

        <FilterField label="Captured by">
          <select
            value={value.capturedById ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                capturedById: e.target.value === "" ? null : e.target.value,
              })
            }
            disabled={captureBy.length === 0}
            className="block h-10 w-full min-w-0 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60 sm:w-auto sm:min-w-[10rem] sm:max-w-[11rem]"
          >
            <option value="">Anyone</option>
            {captureBy.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Area">
          <select
            value={value.areaId ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                areaId: e.target.value === "" ? null : e.target.value,
              })
            }
            className="block h-10 w-full min-w-0 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none sm:w-auto sm:min-w-[10rem] sm:max-w-[11rem]"
          >
            <option value="">Any area</option>
            <option value={NO_AREA}>No area (untagged)</option>
            {areaOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Stage">
          <select
            value={value.stage ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                stage: e.target.value === "" ? null : (e.target.value as EvidenceStage),
              })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          >
            <option value="">Any stage</option>
            {EVIDENCE_STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </select>
        </FilterField>

        {aiLabelsEnabled ? (
          <FilterField label="Label">
            <select
              value={value.label ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  label: e.target.value === "" ? null : e.target.value,
                })
              }
              className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
            >
              <option value="">All</option>
              <option value={NO_LABELS}>Unlabelled</option>
              {PHOTO_LABEL_TAXONOMY.map((l) => (
                <option key={l} value={l}>
                  {photoLabelDisplay(l)}
                </option>
              ))}
            </select>
          </FilterField>
        ) : null}

        <FilterField label="From">
          <input
            type="date"
            value={value.fromDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, fromDate: e.target.value === "" ? null : e.target.value })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </FilterField>

        <FilterField label="To">
          <input
            type="date"
            value={value.toDate ?? ""}
            onChange={(e) =>
              onChange({ ...value, toDate: e.target.value === "" ? null : e.target.value })
            }
            className="block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none"
          />
        </FilterField>

        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-card border border-border bg-surface px-3 text-sm">
          <input
            type="checkbox"
            checked={value.unattachedOnly}
            onChange={(e) => onChange({ ...value, unattachedOnly: e.target.checked })}
            className="h-4 w-4 accent-brand-navy"
          />
          {/* Distinct from the "No area (untagged)" axis above: this means NO
              stage AND NO area AND NO task — a fully context-free capture. */}
          <span>No context at all</span>
        </label>

        {!isDefault ? (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTER)}
            className={cn(
              "inline-flex h-10 items-center gap-1 rounded-card px-3 text-sm font-medium",
              "text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2",
              "hover:bg-surface-subtle"
            )}
          >
            <X aria-hidden="true" className="h-4 w-4" />
            Clear filters
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-xs text-text-muted">
        Showing <Pill tone="neutral">{visibleCount}</Pill> of {items.length} evidence
        {items.length === 1 ? " item" : " items"} on this job.
      </p>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block font-display text-xs uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * Pure filter predicate. Exported so tests can verify the matrix
 * without rendering the bar. Date comparison uses ISO YYYY-MM-DD
 * prefix-matching against `capturedAt` (which is a full ISO string).
 */
export function matchesFilter(item: EvidenceItem, filter: FilterState): boolean {
  if (filter.status !== "all" && item.status !== filter.status) return false;
  if (filter.capturedById && item.capturedById !== filter.capturedById) return false;
  if (filter.unattachedOnly) {
    const attached = item.stage || item.areaId || item.taskId;
    if (attached) return false;
  }
  // Area context (#260). NO_AREA matches captures with no areaId; an explicit
  // areaId matches exactly. AND-combines with everything else.
  if (filter.areaId === NO_AREA) {
    if (item.areaId) return false;
  } else if (filter.areaId && item.areaId !== filter.areaId) {
    return false;
  }
  // Stage context (#260).
  if (filter.stage && item.stage !== filter.stage) return false;
  // Task context (#260) — exact taskId match when set.
  if (filter.taskId && item.taskId !== filter.taskId) return false;
  // Label axis (#262). NO_LABELS matches rows with no VISIBLE labels
  // (rejected / below-confidence-floor entries don't count); a taxonomy
  // label matches via the display contract. AND-combines with the rest.
  if (filter.label === NO_LABELS) {
    if (!isUnlabelled(item)) return false;
  } else if (filter.label && !hasVisibleLabel(item, filter.label)) {
    return false;
  }
  if (filter.fromDate || filter.toDate) {
    const day = typeof item.capturedAt === "string" ? item.capturedAt.slice(0, 10) : "";
    if (filter.fromDate && day < filter.fromDate) return false;
    if (filter.toDate && day > filter.toDate) return false;
  }
  return true;
}
