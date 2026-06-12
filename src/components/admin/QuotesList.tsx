"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Plus } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { createQuote } from "@/domains/quoting/client";
import { quoteStatusLabel, quoteStatusTone } from "@/domains/quoting/format";
import { formatMoney } from "@/domains/quoting/totals";
import type { QuoteSummary } from "@/domains/quoting/schema";

/**
 * /v2/quotes list body (#183) — summary rows straight off the quotes-v2
 * registry (name · status · last edited · total inc GST) plus the create
 * entry point. Row click opens the builder.
 *
 * NEW QUOTES ONLY (the #172 ruling): this surface reads the v2 store. The
 * two pre-rebuild draft shells (plan-image uploads, no estimating data)
 * stay in the legacy store and are deliberately NOT listed here — the
 * honest note below says so instead of silently hiding them.
 */

interface QuotesListProps {
  quotes: ReadonlyArray<QuoteSummary>;
}

export function QuotesList({ quotes }: QuotesListProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  async function onCreate() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    const result = await createQuote({ name: trimmed });
    if (result.ok) {
      router.push(`/v2/quotes/${result.data.quote.id}` as Route);
      return; // keep `creating` on while we navigate
    }
    setCreating(false);
    setCreateError(result.error.message || "Couldn’t create the quote. Try again.");
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle>Quotes</CardTitle>
            <CardDescription className="mt-1">
              Build a quote out of sections and line items — totals update as you type.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm text-text-muted">
              {quotes.length === 0
                ? "No quotes yet"
                : `${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"}`}
            </p>
            {!formOpen ? (
              <Button data-testid="quotes-new-quote" onClick={() => setFormOpen(true)}>
                <Plus aria-hidden="true" className="h-4 w-4" /> New quote
              </Button>
            ) : null}
          </div>
        </div>

        {formOpen ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onCreate();
            }}
          >
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
              <span className="font-medium text-text">Quote name</span>
              <input
                data-testid="quotes-new-name"
                autoFocus
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Birdwood St rewire"
                className="h-10 rounded-card border border-border bg-surface px-3 text-sm text-text focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy"
              />
            </label>
            <div className="flex items-center gap-2">
              <Button type="submit" data-testid="quotes-create-submit" disabled={!name.trim() || creating}>
                {creating ? "Creating…" : "Create quote"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setFormOpen(false);
                  setName("");
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
            </div>
            {createError ? (
              <p className="w-full text-sm text-state-danger" role="alert">
                {createError}
              </p>
            ) : null}
          </form>
        ) : null}
      </Card>

      {quotes.length === 0 ? (
        <Card data-testid="quotes-empty">
          <CardTitle>No quotes yet</CardTitle>
          <CardDescription className="mt-1">
            Create your first quote to start pricing a job — sections for the scope, line items
            for the numbers.
          </CardDescription>
        </Card>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-border" data-testid="quotes-rows">
            {quotes.map((q) => (
              <li key={q.id}>
                <Link
                  href={`/v2/quotes/${q.id}` as Route}
                  data-testid={`quotes-row-${q.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-navy"
                >
                  <span className="min-w-40 flex-1 truncate font-medium text-text">{q.name}</span>
                  <Pill tone={quoteStatusTone(q.status)}>{quoteStatusLabel(q.status)}</Pill>
                  <span className="text-sm text-text-muted">
                    {q.lineCount === 1 ? "1 line" : `${q.lineCount} lines`}
                  </span>
                  <span className="text-sm text-text-muted">{formatWhen(q.updatedAt)}</span>
                  <span className="w-28 text-right text-sm font-medium tabular-nums text-text">
                    {formatMoney(q.totalIncGst)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Honest scope note — see the component header. */}
      <p className="text-xs text-text-muted" data-testid="quotes-legacy-note">
        This surface holds quotes created in BuhlOS. The two pre-rebuild draft quotes (uploaded
        plan sets, no pricing) remain in the old quoting store and aren&rsquo;t listed here.
      </p>
    </div>
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
