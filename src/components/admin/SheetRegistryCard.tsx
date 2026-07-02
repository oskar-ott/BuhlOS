"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  SHEET_TYPES,
  SHEET_TYPE_LABELS,
  type SheetType,
} from "@/domains/ai-drawings/schema";
import {
  filterRegistryRows,
  type RegistryRow,
} from "@/domains/ai-drawings/registry";

/**
 * Epic 5 (#199) — the searchable sheet registry: every classified sheet on
 * the job with number, title, type, revision, scale and its source document,
 * searchable by number/title substring and filterable by type; each row
 * deep-links to the rendered page image.
 *
 * READ-ONLY over the #197 extraction data — corrections happen in the
 * review flow below, and flow through here automatically (override wins).
 * Unreviewed / low-confidence rows are visibly marked so nobody mistakes an
 * unverified AI read for a checked register entry (P7).
 */
export function SheetRegistryCard({ rows }: { rows: RegistryRow[] }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SheetType | "all">("all");

  const visible = useMemo(
    () => filterRegistryRows(rows, query, type),
    [rows, query, type],
  );
  const needsReviewCount = useMemo(
    () => rows.filter((r) => r.needsReview).length,
    [rows],
  );

  return (
    <section
      aria-label="Sheet registry"
      className="rounded-card border border-border bg-surface"
      data-testid="sheet-registry"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Sheet registry</CardTitle>
        <CardDescription className="mt-1">
          Every sheet the AI has read on this job — search it instead of
          paging through PDFs. Corrections made below always win here.
        </CardDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search number or title…"
              aria-label="Search sheets by number or title"
              className="h-9 w-full rounded-card border border-border bg-surface pl-8 pr-3 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by sheet type">
            <TypeChip
              label="All"
              active={type === "all"}
              onClick={() => setType("all")}
            />
            {SHEET_TYPES.map((t) => (
              <TypeChip
                key={t}
                label={SHEET_TYPE_LABELS[t]}
                active={type === t}
                onClick={() => setType(t)}
              />
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-text-muted" role="status">
          {visible.length} of {rows.length} sheet{rows.length === 1 ? "" : "s"}
          {needsReviewCount > 0 ? ` · ${needsReviewCount} unreviewed` : ""}
        </p>
      </div>

      {visible.length === 0 ? (
        <p className="p-4 text-center text-sm text-text-muted">
          No sheets match this search.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((r) => (
            <li
              key={`${r.planId}:${r.pageIndex}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
              data-testid="sheet-registry-row"
            >
              <span className="w-20 shrink-0 font-mono text-sm font-semibold text-text">
                {r.sheetNumber ?? "—"}
              </span>
              <span className="min-w-0 flex-1 break-words text-sm text-text">
                {r.sheetTitle ?? <span className="text-text-muted">(no title read)</span>}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {r.sheetType ? (
                  <Pill tone="neutral">
                    {SHEET_TYPE_LABELS[r.sheetType as SheetType] ?? r.sheetType}
                  </Pill>
                ) : null}
                {r.revision ? <Pill tone="neutral">Rev {r.revision}</Pill> : null}
                {r.scale ? <span className="text-xs text-text-muted">{r.scale}</span> : null}
                {r.needsReview ? <Pill tone="warning">unreviewed</Pill> : null}
                {r.corrected ? <Pill tone="info">corrected</Pill> : null}
              </span>
              <span className="flex w-full items-center gap-2 text-xs text-text-muted sm:w-auto">
                <span className="truncate">
                  {r.docLabel} · p{r.pageIndex + 1}
                  {r.docStatus !== "current" ? ` · ${r.docStatus}` : ""}
                </span>
                {r.pngUrl ? (
                  <a
                    href={r.pngUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open sheet ${r.sheetNumber ?? `page ${r.pageIndex + 1}`} image (opens in a new tab)`}
                    className="inline-flex shrink-0 items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-text"
                  >
                    open
                    <ExternalLink aria-hidden="true" className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TypeChip({
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
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
      )}
    >
      {label}
    </button>
  );
}
