"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import type { EvidenceItem, ServerEvidenceStatus } from "@/domains/evidence/types";
import { cn } from "@/lib/cn";

export type StatusFilter = "all" | ServerEvidenceStatus;

export interface FilterState {
  status: StatusFilter;
  capturedById: string | null;
  unattachedOnly: boolean;
  fromDate: string | null; // YYYY-MM-DD
  toDate: string | null;   // YYYY-MM-DD
}

export const DEFAULT_FILTER: FilterState = {
  status: "submitted",
  capturedById: null,
  unattachedOnly: false,
  fromDate: null,
  toDate: null,
};

interface Props {
  items: ReadonlyArray<EvidenceItem>;
  value: FilterState;
  onChange: (next: FilterState) => void;
  /** Visible row count after the filter is applied. Drives the "showing N
   *  of M" copy in the bar. */
  visibleCount: number;
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
export function EvidenceFilterBar({ items, value, onChange, visibleCount }: Props) {
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

  const isDefault =
    value.status === DEFAULT_FILTER.status &&
    value.capturedById === DEFAULT_FILTER.capturedById &&
    value.unattachedOnly === DEFAULT_FILTER.unattachedOnly &&
    value.fromDate === DEFAULT_FILTER.fromDate &&
    value.toDate === DEFAULT_FILTER.toDate;

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
            className="block h-10 min-w-[10rem] rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          >
            <option value="">Anyone</option>
            {captureBy.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FilterField>

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
          <span>Unattached only</span>
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
  if (filter.fromDate || filter.toDate) {
    const day = typeof item.capturedAt === "string" ? item.capturedAt.slice(0, 10) : "";
    if (filter.fromDate && day < filter.fromDate) return false;
    if (filter.toDate && day > filter.toDate) return false;
  }
  return true;
}
