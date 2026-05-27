"use client";

import { useMemo } from "react";
import { ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  categoryLabel,
  displayTitle,
  drawingContextLine,
  isCurrent,
  mimeTypeLabel,
} from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";
import { cn } from "@/lib/cn";

interface Props {
  /** Initial document list fetched server-side. May be empty. */
  initialDocuments?: ReadonlyArray<Document>;
  /** Non-blocking error from the server fetch — surfaces an info bar
   *  but the panel still renders so the worker can re-try with a
   *  refresh. */
  fetchError?: string | null;
}

/**
 * Phil — Job documents / specs panel (Phase E2, read-only).
 *
 * Replaces the PR #37 UC stub with a live, worker-safe document list.
 * Sits below JobItpPanel in PhilJobDetail (per the same vertical
 * render order — header → site → stage → areas → capture → strip →
 * Snags → ITPs → Documents → Materials → History).
 *
 * Workers see **current revisions only.** Superseded + archived rows
 * are filtered client-side here — the server already strips
 * `status === 'archived'` for non-admin callers, so this layer handles
 * the `superseded` case. The motivation is field safety: a worker who
 * sees two cards for the same drawing might install per the old
 * revision; the rebuild treats "show the current revision and nothing
 * else" as a hard rule.
 *
 * No drawer, no preview, no upload, no markup tools — every action is
 * "Open" which targets `_blank` on the Vercel Blob URL. Phase 9 AI
 * takeoff stays admin-only on the legacy /admin/plans SPA.
 *
 * Cross-ref:
 *   src/components/phil/JobItpPanel.tsx — pattern precedent
 *   src/domains/documents/format.ts — display helpers
 *   docs/rebuild-audit/36-documents-specs-readiness-note.md
 */
export function JobDocumentsPanel({
  initialDocuments = [],
  fetchError = null,
}: Props) {
  const current = useMemo(
    () => initialDocuments.filter(isCurrent),
    [initialDocuments],
  );

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Documents &amp; specs</CardTitle>
          <CardDescription className="mt-1">
            Current drawings and specs for this job. Tap a row to open
            the file.
          </CardDescription>
        </div>
        {current.length > 0 ? (
          <Pill tone="neutral">
            {current.length}
            {current.length === 1 ? " current" : " current"}
          </Pill>
        ) : null}
      </div>

      {fetchError ? (
        <p
          role="status"
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Couldn&rsquo;t load every document. Showing what we have. Refresh
          to try again.
        </p>
      ) : null}

      {current.length === 0 ? (
        <p
          className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted"
          role="status"
        >
          {initialDocuments.length === 0
            ? "No documents on this job yet. Your PM uploads them on the office app."
            : "No current revisions — everything on this job has been superseded. Ask your PM which one to use."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {current.map((doc) => (
            <li key={doc.id}>
              <DocumentRow doc={doc} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DocumentRow({ doc }: { doc: Document }) {
  const title = displayTitle(doc);
  const drawing = drawingContextLine(doc);
  const cat = categoryLabel(doc.category);
  const mime = mimeTypeLabel(doc.mimeType);
  const IconComponent = doc.mimeType?.startsWith("image/")
    ? ImageIcon
    : FileText;

  return (
    <a
      href={doc.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex min-h-[64px] items-center gap-3 rounded-card border border-border bg-surface px-4 py-3",
        "transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
      )}
      aria-label={`Open ${title} (${mime}, opens in a new tab)`}
    >
      <IconComponent
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-text-muted"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-base font-semibold text-text">
          {title}
        </span>
        {drawing ? (
          <span className="mt-0.5 block truncate text-xs text-text-muted">
            {drawing}
          </span>
        ) : null}
        <span className="mt-1 inline-flex items-center gap-2 text-xs text-text-muted">
          <Pill tone="neutral">{cat}</Pill>
          <span>{mime}</span>
        </span>
      </span>
      <ExternalLink
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-text-muted/60"
      />
    </a>
  );
}
