"use client";

import { useMemo, useState } from "react";
import { MapPin, StickyNote, Minus, Hexagon, ArrowUpRight, Type, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { MARKUP_TYPES } from "@/domains/plan-markups/schema";
import type { DrawingMarkup, MarkupType } from "@/domains/plan-markups/types";

/**
 * Plan markup MANAGE panel (Plans Phase 3, annotation slice — #651).
 *
 * A pure projection over the controller's already-scoped page markups: a list
 * with per-row type icon + label + visible-to-Phil pill, filters by type and
 * visibility, click-to-select (highlights + opens the controller's detail
 * panel), and bulk toggle-visibility / archive over a checkbox selection.
 *
 * It owns NO markup state and does NO fetching — every mutation is delegated up
 * to the controller's existing per-record client (looped). ADMIN-ONLY: the
 * controller only renders this in admin mode, so Phil never sees it.
 */

const TYPE_ICON: Record<MarkupType, typeof MapPin> = {
  pin: MapPin,
  note: StickyNote,
  line: Minus,
  area: Hexagon,
  arrow: ArrowUpRight,
  text: Type,
};

type VisibilityFilter = "all" | "visible" | "office";

function markupRowLabel(m: DrawingMarkup): string {
  const label = m.label?.trim();
  if (label) return label;
  const text = m.text?.trim();
  if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  return `Unlabelled ${m.type}`;
}

interface Props {
  markups: ReadonlyArray<DrawingMarkup>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBulkSetVisible: (ids: ReadonlyArray<string>, visibleToPhil: boolean) => void;
  onBulkArchive: (ids: ReadonlyArray<string>) => void;
  busy?: boolean;
}

export function PlanMarkupManagePanel({
  markups,
  selectedId,
  onSelect,
  onBulkSetVisible,
  onBulkArchive,
  busy = false,
}: Props) {
  const [typeFilter, setTypeFilter] = useState<MarkupType | "all">("all");
  const [visFilter, setVisFilter] = useState<VisibilityFilter>("all");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(
    () =>
      markups.filter((m) => {
        if (typeFilter !== "all" && m.type !== typeFilter) return false;
        if (visFilter === "visible" && !m.visibleToPhil) return false;
        if (visFilter === "office" && m.visibleToPhil) return false;
        return true;
      }),
    [markups, typeFilter, visFilter],
  );

  // Checked ids that still exist in the current rows (filtering/archiving can
  // drop them); the bulk actions operate over this live set.
  const selectedIds = useMemo(
    () => rows.filter((m) => checked.has(m.id)).map((m) => m.id),
    [rows, checked],
  );

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearChecked = () => setChecked(new Set());

  return (
    <Card className="space-y-3" data-testid="overlay-manage-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Manage overlays</CardTitle>
        <span className="text-xs text-text-muted">
          {`${rows.length} of ${markups.length} shown`}
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" data-testid="manage-filters">
        <label className="text-xs text-text-muted">
          <span className="sr-only">Filter by type</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as MarkupType | "all")}
            className="rounded-card border border-border bg-surface px-2 py-1 text-sm"
            aria-label="Filter by type"
          >
            <option value="all">All types</option>
            {MARKUP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-muted">
          <span className="sr-only">Filter by visibility</span>
          <select
            value={visFilter}
            onChange={(e) => setVisFilter(e.target.value as VisibilityFilter)}
            className="rounded-card border border-border bg-surface px-2 py-1 text-sm"
            aria-label="Filter by visibility"
          >
            <option value="all">All visibility</option>
            <option value="visible">Visible to Phil</option>
            <option value="office">Office only</option>
          </select>
        </label>
      </div>

      {/* Rows */}
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="manage-empty">
          No overlays match these filters.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border" data-testid="manage-list">
          {rows.map((m) => {
            const Icon = TYPE_ICON[m.type] ?? MapPin;
            const isSelected = m.id === selectedId;
            const isChecked = checked.has(m.id);
            return (
              <li
                key={m.id}
                className={cn(
                  "flex items-center gap-2 px-3 py-2",
                  isSelected ? "bg-surface-subtle" : "bg-surface",
                )}
                data-testid="manage-row"
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleChecked(m.id)}
                  aria-label={`Select ${markupRowLabel(m)}`}
                  className="h-4 w-4"
                />
                <button
                  type="button"
                  onClick={() => onSelect(m.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-current={isSelected ? "true" : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
                  <span className="truncate text-sm text-text">{markupRowLabel(m)}</span>
                </button>
                {m.asBuilt ? <Pill tone="warning">As-built</Pill> : null}
                <Pill tone={m.visibleToPhil ? "success" : "neutral"}>
                  {m.visibleToPhil ? "Visible" : "Office"}
                </Pill>
              </li>
            );
          })}
        </ul>
      )}

      {/* Bulk actions over the checkbox selection */}
      <div className="flex flex-wrap items-center gap-2" data-testid="manage-bulk">
        <span className="text-xs text-text-muted">
          {`${selectedIds.length} selected`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || selectedIds.length === 0}
          onClick={() => onBulkSetVisible(selectedIds, true)}
          data-testid="manage-bulk-show"
        >
          <Eye className="h-4 w-4" aria-hidden /> Show to Phil
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || selectedIds.length === 0}
          onClick={() => onBulkSetVisible(selectedIds, false)}
          data-testid="manage-bulk-hide"
        >
          <EyeOff className="h-4 w-4" aria-hidden /> Hide from Phil
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy || selectedIds.length === 0}
          onClick={() => { onBulkArchive(selectedIds); clearChecked(); }}
          data-testid="manage-bulk-archive"
        >
          <Trash2 className="h-4 w-4" aria-hidden /> Archive
        </Button>
      </div>
    </Card>
  );
}
