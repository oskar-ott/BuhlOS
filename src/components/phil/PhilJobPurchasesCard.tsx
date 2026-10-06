"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ShoppingCart } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { jobPurchases } from "@/domains/invoices/client";
import type { JobPurchase } from "@/domains/invoices/schema";
import { formatShortDate, purchaseHeadline, purchaseLineLabel } from "@/domains/invoices/format";

/** Purchases shown before "Show all". */
const FIRST = 3;

/**
 * Phil job page — "What's been bought" (job_purchases; owner pull 2026-10-04:
 * "view recent purchases from wholesalers on the job easily and simply").
 * The newest wholesaler invoices and field receipts on this job: when, where
 * from, who bought it, and the items — so the crew can check before ordering
 * the same thing twice.
 *
 * Phil constitution: P14 — Phil remembers what's already been bought so the
 * worker doesn't; P1 — the trade counter is site reality; P10 — enters the
 * single reference group as one quiet card, and is ABSENT until there is at
 * least one purchase (no empty slot); P7 — only confirmed purchases, says so
 * when more are still with the office, and NEVER a price (the server sends
 * none below the office tier, and this card renders none even if it did);
 * P8 — each purchase is a native <details> row (48px, opens without script);
 * a failed or offline read leaves no trace. P11 — "What's been bought".
 *
 * The body is a pure prop-driven sub-component so it's SSR-render-testable.
 */
export function PhilJobPurchasesBody({
  purchases,
  totalCount,
  awaitingCount,
}: {
  purchases: ReadonlyArray<JobPurchase>;
  totalCount: number;
  awaitingCount: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? purchases : purchases.slice(0, FIRST);
  return (
    <>
      <ul className="mt-2 divide-y divide-border" aria-label="What's been bought">
        {visible.map((p) => (
          <li key={p.id}>
            <details className="group">
              <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                    {p.date ? formatShortDate(p.date) : "Date not read"}
                  </span>
                  <span className="block break-words text-[15px] font-semibold leading-snug text-text">
                    {purchaseHeadline(p)}
                  </span>
                </span>
                <span className="shrink-0 text-[13px] text-text-muted">
                  {p.lines.length > 0 ? `${p.lines.length} ${p.lines.length === 1 ? "item" : "items"}` : ""}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 text-text-muted transition-transform group-open:rotate-180"
                />
              </summary>
              {p.lines.length > 0 ? (
                <ul className="mb-3 space-y-1 pl-1 text-[14px] text-text">
                  {p.lines.map((l, i) => (
                    <li key={i} className="break-words">
                      {purchaseLineLabel(l)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-3 text-[13px] text-text-muted">
                  The items on this one couldn&rsquo;t be read — ask the office.
                </p>
              )}
            </details>
          </li>
        ))}
      </ul>
      {purchases.length > FIRST ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4"
        >
          {showAll ? "Show fewer" : `Show ${purchases.length - FIRST} more`}
        </button>
      ) : null}
      {totalCount > purchases.length || awaitingCount > 0 ? (
        <p className="mt-1 text-[13px] text-text-muted">
          {totalCount > purchases.length ? `Latest ${purchases.length} of ${totalCount}.` : ""}
          {totalCount > purchases.length && awaitingCount > 0 ? " " : ""}
          {awaitingCount > 0
            ? `${awaitingCount} more ${awaitingCount === 1 ? "is" : "are"} still with the office.`
            : ""}
        </p>
      ) : null}
    </>
  );
}

export function PhilJobPurchasesCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<{
    purchases: ReadonlyArray<JobPurchase>;
    totalCount: number;
    awaitingCount: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void jobPurchases(jobId).then((r) => {
      if (!alive || !r.ok) return;
      setData({
        purchases: r.data.purchases,
        totalCount: r.data.totalCount,
        awaitingCount: r.data.awaitingCount,
      });
    });
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Hidden until real: nothing while loading, on a failed read, or when
  // nothing has been bought yet (P10 — no empty slot on the job page).
  if (!data || data.purchases.length === 0) return null;

  return (
    <section id="phil-job-purchases" aria-label="What's been bought" className="scroll-mt-16" data-testid="phil-job-purchases">
      <Card>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart aria-hidden="true" className="h-4 w-4 text-text-muted" />
          What&rsquo;s been bought
        </CardTitle>
        <PhilJobPurchasesBody
          purchases={data.purchases}
          totalCount={data.totalCount}
          awaitingCount={data.awaitingCount}
        />
      </Card>
    </section>
  );
}
