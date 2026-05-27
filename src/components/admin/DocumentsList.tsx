"use client";

import { useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  FileText,
  History,
  Image as ImageIcon,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  categoryLabel,
  displayTitle,
  drawingContextLine,
  formatFileSize,
  groupByDrawing,
  mimeTypeLabel,
  statusLabel,
  statusTone,
  type DocumentStatusTone,
} from "@/domains/documents/format";
import type { Document, DocumentStatus } from "@/domains/documents/types";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
  initialDocuments: ReadonlyArray<Document>;
  fetchError: string | null;
}

type FilterMode = "current" | "all";

const STATUS_PILL_TONE: Record<
  DocumentStatusTone,
  "info" | "success" | "warning" | "neutral"
> = {
  info: "info",
  success: "success",
  neutral: "neutral",
};

/**
 * Phase E2 — admin documents list (read-only).
 *
 * Server component (page.tsx) does the initial fetch; this client
 * component owns filter state + the "Show old revisions" expander
 * per drawing. No mutations, no drawer with action buttons — every
 * row links to the file via `_blank`.
 *
 * Filter modes:
 *   - `current` (default) — only `status === 'current'` rows
 *     (and rows without a status field, which the writer defaults
 *     to current).
 *   - `all` — every row including superseded + archived. Useful for
 *     the office user reconciling revision history.
 *
 * Within a drawing number, the current revision lands at the top of
 * the group; "Previous revisions (N)" is a chevron expander that
 * reveals the older revisions below.
 *
 * Cross-ref:
 *   src/components/admin/ITPsQueue.tsx — pattern precedent
 *   src/domains/documents/format.ts
 *   docs/rebuild-audit/36-documents-specs-readiness-note.md
 */
export function DocumentsList({
  job,
  initialDocuments,
  fetchError,
}: Props) {
  const [filter, setFilter] = useState<FilterMode>("current");

  const filtered = useMemo(() => {
    if (filter === "current") {
      return initialDocuments.filter(
        (d) => !d.status || d.status === "current",
      );
    }
    return initialDocuments;
  }, [initialDocuments, filter]);

  const groups = useMemo(() => groupByDrawing(filtered), [filtered]);

  const currentCount = useMemo(
    () =>
      initialDocuments.filter((d) => !d.status || d.status === "current")
        .length,
    [initialDocuments],
  );
  const supersededCount = useMemo(
    () => initialDocuments.filter((d) => d.status === "superseded").length,
    [initialDocuments],
  );
  const archivedCount = useMemo(
    () => initialDocuments.filter((d) => d.status === "archived").length,
    [initialDocuments],
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Documents &amp; specs · {job.name}</CardTitle>
            <CardDescription className="mt-1">
              Plans, specs and schedules attached to this job. Read-only
              viewer — uploads + revision curation live on the legacy{" "}
              <a
                href="/admin/plans"
                className="underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                /admin/plans
              </a>{" "}
              surface.
            </CardDescription>
          </div>
          <Pill tone="neutral">Read-only</Pill>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist">
          <FilterTab
            label={`Current (${currentCount})`}
            active={filter === "current"}
            onClick={() => setFilter("current")}
          />
          <FilterTab
            label={`All (${initialDocuments.length})`}
            active={filter === "all"}
            onClick={() => setFilter("all")}
            hint={
              supersededCount + archivedCount > 0
                ? `${supersededCount} superseded · ${archivedCount} archived`
                : undefined
            }
          />
        </div>
      </Card>

      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load every document</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. Showing what we have. Refresh to try again.
          </CardDescription>
        </Card>
      ) : null}

      {filtered.length === 0 ? (
        <Card>
          <p
            className="rounded-card border border-dashed border-border bg-surface-subtle p-6 text-center text-sm text-text-muted"
            role="status"
          >
            {initialDocuments.length === 0
              ? "No documents on this job yet."
              : filter === "current"
                ? "No current documents — every row on this job is superseded or archived."
                : "No documents matching this filter."}
          </p>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
            {groups.map((g, idx) => (
              <li key={`${g.drawingNumber ?? "none"}:${idx}`}>
                <DrawingGroup group={g} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function FilterTab({
  label,
  active,
  hint,
  onClick,
}: {
  label: string;
  active: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle",
      )}
      title={hint}
    >
      {label}
    </button>
  );
}

function DrawingGroup({
  group,
}: {
  group: { drawingNumber: string | null; documents: ReadonlyArray<Document> };
}) {
  const [showOlder, setShowOlder] = useState(false);
  // Current (or no-status) revision lands at the top; everything else
  // is "older". For groups where the latest revision is itself
  // superseded / archived, we still show it at the top — the
  // groupByDrawing sort orders by uploadedAt newest-first regardless.
  const [head, ...rest] = group.documents;
  if (!head) return null;
  return (
    <div className="px-4 py-3">
      <DocumentRow doc={head} />
      {rest.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowOlder((v) => !v)}
            className="inline-flex items-center gap-1 text-xs font-medium text-text-muted underline decoration-dotted underline-offset-2 hover:text-text"
            aria-expanded={showOlder}
            aria-controls={`older-${group.drawingNumber ?? "none"}`}
          >
            <History aria-hidden="true" className="h-3.5 w-3.5" />
            {showOlder ? "Hide" : "Show"} {rest.length} previous{" "}
            {rest.length === 1 ? "revision" : "revisions"}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                showOlder ? "rotate-90" : "",
              )}
            />
          </button>
          {showOlder ? (
            <ul
              id={`older-${group.drawingNumber ?? "none"}`}
              className="mt-2 space-y-2 border-l border-border pl-3"
            >
              {rest.map((doc) => (
                <li key={doc.id}>
                  <DocumentRow doc={doc} muted />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DocumentRow({
  doc,
  muted = false,
}: {
  doc: Document;
  muted?: boolean;
}) {
  const title = displayTitle(doc);
  const drawing = drawingContextLine(doc);
  const cat = categoryLabel(doc.category);
  const mime = mimeTypeLabel(doc.mimeType);
  const size = formatFileSize(doc.sizeBytes);
  const IconComponent = doc.mimeType?.startsWith("image/")
    ? ImageIcon
    : FileText;
  const status: DocumentStatus | undefined = doc.status;
  return (
    <div
      className={cn(
        "flex items-start gap-3",
        muted ? "opacity-80" : "",
      )}
    >
      <IconComponent
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 text-text-muted"
      />
      <div className="min-w-0 flex-1">
        <p className="break-words font-display text-base font-semibold text-text">
          {title}
        </p>
        {drawing ? (
          <p className="mt-0.5 text-xs text-text-muted">{drawing}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <Pill tone={STATUS_PILL_TONE[statusTone(status)]}>
            {statusLabel(status)}
          </Pill>
          <Pill tone="neutral">{cat}</Pill>
          <span>{mime}</span>
          {size ? <span aria-hidden="true">·</span> : null}
          {size ? <span>{size}</span> : null}
          {doc.uploadedBy ? (
            <>
              <span aria-hidden="true">·</span>
              <span>by {doc.uploadedBy}</span>
            </>
          ) : null}
        </div>
        {doc.notes ? (
          <p className="mt-1.5 text-xs text-text-muted">{doc.notes}</p>
        ) : null}
      </div>
      <a
        href={doc.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${title} (opens in a new tab)`}
        className={cn(
          "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-card border border-border bg-surface px-3 text-sm font-medium text-text transition-colors",
          "hover:border-border-strong hover:bg-surface-subtle",
          "focus:outline-none focus:ring-2 focus:ring-brand-navy",
        )}
      >
        Open
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    </div>
  );
}
