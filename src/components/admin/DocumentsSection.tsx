"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, FileText, Image as ImageIcon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { DocumentUploadButton } from "@/components/admin/DocumentUploadButton";
import { listDocuments, setDocumentFieldVisibility } from "@/domains/documents/client";
import {
  categoryLabel,
  compareForQueue,
  displayTitle,
  statusLabel,
  statusTone,
} from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";
import { cn } from "@/lib/cn";

/**
 * Documents — the builder's Documents step (Job Builder redesign · Wave 4b,
 * dark behind job_builder_redesign). The job's document register with upload
 * (the shell-neutral DocumentUploadButton) and a per-file "Visible to field"
 * toggle writing Document.visibleToField (additive — absent = visible, so
 * every pre-existing row keeps today's behaviour).
 *
 * The toggle is REAL enforcement, not a client-side hide: api/plans.js GET
 * filters `visibleToField === false` rows out for every non-admin viewer,
 * so a hidden file never reaches the Phil plans viewer. This list is an
 * admin surface — it shows every row (hidden + archived included),
 * honestly labelled.
 *
 * The prototype's AI auto-fill extract-card UX is NOT built here — it stays
 * under "Optional / later" in docs/job-builder-redesign.md.
 */

type Load =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready" };

interface Props {
  jobId: string;
  /** AI metadata auto-fill on the uploader (behind `ai_drawings`, resolved by
   *  the caller). Off by default so the register stays unchanged when dark. */
  aiAutofillEnabled?: boolean;
}

export function DocumentsSection({ jobId, aiAutofillEnabled = false }: Props) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [docs, setDocs] = useState<Document[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ phase: "loading" });
    const res = await listDocuments(jobId);
    if (!res.ok) {
      setLoad({ phase: "error", message: res.error.message });
      return;
    }
    setDocs(res.data.plans.slice().sort(compareForQueue));
    setLoad({ phase: "ready" });
  }, [jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleVisibility(doc: Document) {
    const next = doc.visibleToField === false; // hidden → show; visible → hide
    setBusyId(doc.id);
    setToggleError(null);
    const res = await setDocumentFieldVisibility(jobId, doc.id, next);
    setBusyId(null);
    if (!res.ok) {
      setToggleError(`Couldn't update "${displayTitle(doc)}" — ${res.error.message}`);
      return;
    }
    const saved = res.data.plan;
    setDocs((prev) => prev.map((d) => (d.id === saved.id ? saved : d)));
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Documents</CardTitle>
            <CardDescription className="mt-1">
              Every file on this job — drawings, specs, contracts — and which of
              them the crew can open in Phil.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              disabled={load.phase === "loading"}
              aria-label="Refresh the document list"
              data-testid="documents-refresh"
            >
              <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" /> Refresh
            </Button>
            <DocumentUploadButton jobId={jobId} aiAutofill={aiAutofillEnabled} />
          </div>
        </div>
        <p
          className="mt-3 rounded-card bg-surface-subtle px-3 py-2 text-xs text-text-muted"
          data-testid="documents-truth-note"
        >
          Hidden files never reach the crew&rsquo;s Plans viewer. New uploads are
          visible by default.
        </p>
      </Card>

      {load.phase === "loading" ? (
        <Card>
          <p className="text-sm text-text-muted" role="status">
            Loading documents…
          </p>
        </Card>
      ) : null}

      {load.phase === "error" ? (
        <Card className="border-state-danger" role="alert">
          <CardTitle>Couldn&rsquo;t load the documents</CardTitle>
          <CardDescription className="mt-1">{load.message}</CardDescription>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        </Card>
      ) : null}

      {load.phase === "ready" && docs.length === 0 ? (
        <Card data-testid="documents-empty">
          <p className="rounded-card border border-dashed border-border bg-surface-subtle px-3 py-6 text-center text-sm text-text-muted">
            No documents yet. Upload drawings, specs or the contract — the crew
            sees whatever you leave visible in Phil&rsquo;s Plans.
          </p>
        </Card>
      ) : null}

      {load.phase === "ready" && docs.length > 0 ? (
        <Card>
          {toggleError ? (
            <p
              role="alert"
              className="mb-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger"
            >
              {toggleError}
            </p>
          ) : null}
          <ul className="space-y-2">
            {docs.map((doc) => {
              const visible = doc.visibleToField !== false;
              const busy = busyId === doc.id;
              const RowIcon = doc.mimeType?.startsWith("image/") ? ImageIcon : FileText;
              return (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-3 py-2.5"
                  data-testid="documents-row"
                >
                  <RowIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{displayTitle(doc)}</p>
                    <p className="mt-0.5 text-xs text-text-muted">{categoryLabel(doc.category)}</p>
                  </div>
                  <Pill tone={statusTone(doc.status)}>{statusLabel(doc.status)}</Pill>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${displayTitle(doc)} (opens in a new tab)`}
                    data-testid="document-open"
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text transition-colors",
                      "hover:border-border-strong hover:bg-surface-subtle",
                      "focus:outline-none focus:ring-2 focus:ring-brand-navy",
                    )}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    Open
                  </a>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={visible}
                    aria-label={`Visible to field — ${displayTitle(doc)}`}
                    onClick={() => void toggleVisibility(doc)}
                    disabled={busy}
                    data-testid="document-visibility-toggle"
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60",
                      visible
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-border bg-surface-subtle text-text-muted",
                    )}
                  >
                    {visible ? (
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {busy ? "Saving…" : visible ? "Visible to field" : "Hidden from field"}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
