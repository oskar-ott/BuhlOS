"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { formatMoney } from "@/domains/quoting/totals";
import {
  issueQuotePdf,
  listIssuedQuotePdfs,
  quotePdfPreviewUrl,
  type IssuedQuotePdf,
} from "@/domains/quoting/pdf-client";

/**
 * Client PDF card (#243) on the quote detail page.
 *
 * Two actions, honestly separated:
 *   - "Preview PDF" opens a fresh render (the document itself is stamped
 *     "Preview — not yet issued"; nothing is filed).
 *   - "Generate & file PDF" issues: the server renders from the CLIENT
 *     projection (sell-side only — cost/margin physically can't reach it),
 *     stores the artifact in Blob and appends an immutable register entry.
 *     Re-issuing after edits always produces a NEW entry ("Issue N").
 *
 * Failure is loud: "PDF failed — nothing was issued." — the server writes the
 * register only after the blob exists, so the message is literally true.
 */

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function QuoteClientPdfCard({ quoteId }: { quoteId: string }) {
  const [docs, setDocs] = useState<IssuedQuotePdf[] | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listIssuedQuotePdfs(quoteId);
      if (cancelled) return;
      if (!res.ok) {
        setView("error");
        return;
      }
      setDocs(res.data);
      setView("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [quoteId]);

  async function onIssue() {
    setBusy(true);
    setError(null);
    const res = await issueQuotePdf(quoteId);
    setBusy(false);
    if (!res.ok) {
      setError("PDF failed — nothing was issued. Try again in a moment.");
      return;
    }
    setDocs((d) => [res.data, ...(d ?? [])]);
  }

  return (
    <Card role="region" aria-label="Client PDF">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Client PDF</CardTitle>
          <CardDescription className="mt-1">
            The client-facing quote document — sell-side lines and totals only, never cost or
            margin. Filing keeps the exact artifact you issued.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <a
            href={quotePdfPreviewUrl(quoteId)}
            target="_blank"
            rel="noreferrer"
            data-testid="quote-pdf-preview"
            className="inline-flex h-11 items-center justify-center rounded-card border border-border bg-surface px-3 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle sm:h-8"
          >
            Preview PDF
          </a>
          <Button size="sm" onClick={() => void onIssue()} disabled={busy} data-testid="quote-pdf-issue">
            {busy ? "Generating…" : "Generate & file PDF"}
          </Button>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          data-testid="quote-pdf-error"
        >
          {error}
        </p>
      ) : null}

      {view === "loading" ? (
        <p className="mt-3 text-sm text-text-muted">Loading…</p>
      ) : view === "error" ? (
        <p className="mt-3 text-sm text-text-muted">Couldn&rsquo;t load the issued PDFs.</p>
      ) : docs && docs.length > 0 ? (
        <ul className="mt-3 divide-y divide-border" data-testid="quote-pdf-list">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-40">
                <span className="font-medium text-text">Issue {d.issueNumber}</span>
                <span className="ml-2 text-text-muted">
                  {shortDate(d.issuedAt)} · by {d.issuedBy}
                  {d.totalIncGst !== null ? ` · ${formatMoney(d.totalIncGst)} inc GST` : ""}
                </span>
              </span>
              <a
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-navy underline underline-offset-2"
              >
                Open
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-text-muted" data-testid="quote-pdf-empty">
          No PDF issued yet.
        </p>
      )}
    </Card>
  );
}
