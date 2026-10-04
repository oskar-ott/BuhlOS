"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { jobPurchases } from "@/domains/invoices/client";
import type { JobPurchase, JobPurchases } from "@/domains/invoices/schema";
import {
  formatCentsExact,
  formatShortDate,
  purchaseHeadline,
  purchaseLineLabel,
} from "@/domains/invoices/format";

/** Purchases shown before "Show all". */
const FIRST = 5;
/** Lines shown on a collapsed purchase. */
const PREVIEW_LINES = 2;

/**
 * Office job page — Recent purchases (job_purchases; owner pull 2026-10-04:
 * "view recent purchases from wholesalers on the job easily and simply — only
 * PMs and admins can view the total cost"). Newest first: when, who from, who
 * bought it, what. Everyone who can open this page sees the list; the amounts
 * and the job total appear only when the SERVER sent them (office tier) — a
 * leading hand's response simply has no money in it.
 *
 * Sits beside "Materials cost" (spend by category), which is unchanged: that
 * card answers "where did the money go", this one "what's been bought lately".
 * Hides itself on a 403/404 (flag off / not this viewer's to see).
 */
export function JobRecentPurchasesCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobPurchases | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void jobPurchases(jobId).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setState(res.error.status === 403 || res.error.status === 404 ? "hidden" : "error");
        return;
      }
      setData(res.data);
      setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (state === "hidden") return null;
  const purchases = data?.purchases ?? [];
  const visible = showAll ? purchases : purchases.slice(0, FIRST);

  return (
    <Card id="recent-purchases" data-testid="job-recent-purchases-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardKicker>Recent purchases</CardKicker>
        {data?.costVisible && data.totalCount > 0 ? (
          <span className="text-sm text-text-muted" data-testid="recent-purchases-total">
            <span className="font-semibold tabular-nums text-text">
              {formatCentsExact(data.totalCents ?? 0)}
            </span>{" "}
            ex GST · {data.totalCount} {data.totalCount === 1 ? "purchase" : "purchases"}
          </span>
        ) : null}
      </div>

      {state === "loading" ? (
        <div className="mt-3 h-10 animate-pulse rounded bg-surface-subtle" data-testid="recent-purchases-skeleton" />
      ) : state === "error" ? (
        <p className="mt-2 text-sm text-text-muted">Couldn&rsquo;t load the purchases — refresh to try again.</p>
      ) : purchases.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted" data-testid="recent-purchases-empty">
          Nothing bought on this job yet. Wholesaler invoices show here once the office has checked them.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border" data-testid="recent-purchases-list">
          {visible.map((p) => (
            <PurchaseRow key={p.id} purchase={p} costVisible={Boolean(data?.costVisible)} />
          ))}
        </ul>
      )}

      {state === "ready" ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          {purchases.length > FIRST ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="min-h-[44px] font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              {showAll ? "Show fewer" : `Show ${purchases.length - FIRST} more`}
            </button>
          ) : (
            <span />
          )}
          <span className="text-xs text-text-muted">
            {data && data.totalCount > purchases.length
              ? `Latest ${purchases.length} of ${data.totalCount}`
              : null}
            {data && data.awaitingCount > 0
              ? `${data.totalCount > purchases.length ? " · " : ""}${data.awaitingCount} more waiting for the office to check`
              : null}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function PurchaseRow({ purchase: p, costVisible }: { purchase: JobPurchase; costVisible: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = open ? p.lines : p.lines.slice(0, PREVIEW_LINES);
  const hidden = p.lines.length - lines.length;
  const headline = purchaseHeadline(p);
  return (
    <li className="py-3" data-testid="recent-purchase">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-mono text-xs font-medium uppercase tracking-[0.06em] text-text-muted">
              {p.date ? formatShortDate(p.date) : "Date not read"}
            </span>{" "}
            {costVisible ? (
              <Link
                href={`/invoices/${encodeURIComponent(p.id)}` as Route}
                className="font-semibold text-text hover:underline hover:decoration-accent-yellow hover:decoration-2 hover:underline-offset-4"
              >
                {headline}
              </Link>
            ) : (
              <span className="font-semibold text-text">{headline}</span>
            )}
          </p>
          {p.lines.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text">
              {lines.map((l, i) => (
                <li key={i} className="break-words">
                  {purchaseLineLabel(l)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text-muted">Items couldn&rsquo;t be read from this one.</p>
          )}
          {p.lines.length > PREVIEW_LINES ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-1 min-h-[32px] text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              {open ? "Show less" : `+ ${hidden} more ${hidden === 1 ? "item" : "items"}`}
            </button>
          ) : null}
        </div>
        {costVisible && p.amountCents != null ? (
          <span className="shrink-0 text-sm font-semibold tabular-nums text-text">
            {formatCentsExact(p.amountCents)}
          </span>
        ) : null}
      </div>
    </li>
  );
}
