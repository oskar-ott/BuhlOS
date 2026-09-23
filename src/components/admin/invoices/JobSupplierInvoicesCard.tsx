"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { jobInvoiceSummary } from "@/domains/invoices/client";
import type { JobInvoiceSummary } from "@/domains/invoices/schema";
import { formatCentsExact } from "@/domains/invoices/format";

/**
 * Admin job hub — Supplier invoices (invoice_capture, dark). The page renders
 * this ONLY when the flag is on for the viewer, so a disabled feature leaves
 * no card, no count, no fetch. The figure is the sum of CONFIRMED, active
 * allocations (server-side, never cached); unconfirmed matches are counted
 * separately as "awaiting review" and never enter the total. The link opens
 * the invoices that make up the figure, so the number is always auditable.
 * Hides itself on a 403/404 rather than show a money surface to a non-admin.
 */
export function JobSupplierInvoicesCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobInvoiceSummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void jobInvoiceSummary(jobId).then((res) => {
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

  return (
    <Card id="supplier-invoices" data-testid="job-supplier-invoices-card">
      <CardKicker>Supplier invoices</CardKicker>
      {state === "loading" ? (
        <div className="mt-3 h-10 animate-pulse rounded bg-surface-subtle" data-testid="supplier-invoices-skeleton" />
      ) : state === "error" ? (
        <p className="mt-3 text-sm text-text-muted">Could not load the supplier-invoice figure.</p>
      ) : data ? (
        <>
          <p className="mt-3 font-display text-2xl text-text" data-testid="supplier-invoices-total">
            {data.confirmedCount === 0 ? "—" : formatCentsExact(data.confirmedCents)}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {data.confirmedCount === 0
              ? "No confirmed supplier invoices yet."
              : `Cost excluding GST from ${data.confirmedCount} confirmed ${data.confirmedCount === 1 ? "invoice" : "invoices"} — counted in the Money card's Materials figure.`}
            {data.awaitingCount > 0
              ? ` ${data.awaitingCount} awaiting review (not in the figure).`
              : ""}
          </p>
          <Link
            href={`/invoices?jobId=${encodeURIComponent(jobId)}&status=confirmed` as Route}
            className="mt-3 inline-block text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            View the invoices behind this figure
          </Link>
        </>
      ) : null}
    </Card>
  );
}
