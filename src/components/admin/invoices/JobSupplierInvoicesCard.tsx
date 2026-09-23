"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { pctWidthClass } from "@/components/admin/pct-width";
import { jobMaterialsBreakdown } from "@/domains/invoices/client";
import type { JobMaterialsBreakdown, MaterialCategory } from "@/domains/invoices/schema";
import { formatCentsExact, formatQuantity, formatShortDate } from "@/domains/invoices/format";

/**
 * Admin job hub — Materials used (invoice_capture, dark). Owner pull
 * 2026-09-24: "see all the materials used on a job and a breakdown — cable,
 * fixings, lights". The page renders this ONLY when the flag is on for the
 * viewer, so a disabled feature leaves no card, no count, no fetch.
 *
 * Everything here comes from CONFIRMED supplier invoices (active allocations,
 * credit notes negative) and their line items. The category bars are the sum
 * of the lines; an invoice whose lines could not be read is listed as
 * unitemised so the breakdown never claims more than it knows. Hides itself
 * on a 403/404 rather than show a money surface to a non-admin.
 */
export function JobSupplierInvoicesCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobMaterialsBreakdown | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [open, setOpen] = useState<MaterialCategory | null>(null);

  useEffect(() => {
    let cancelled = false;
    void jobMaterialsBreakdown(jobId).then((res) => {
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
  const maxCents = data ? Math.max(1, ...data.byCategory.map((c) => Math.abs(c.cents))) : 1;

  return (
    <Card id="supplier-invoices" data-testid="job-supplier-invoices-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardKicker>Materials used</CardKicker>
        <span className="text-xs text-text-muted">from confirmed supplier invoices · ex GST</span>
      </div>
      {state === "loading" ? (
        <div
          className="mt-3 h-10 animate-pulse rounded bg-surface-subtle"
          data-testid="supplier-invoices-skeleton"
        />
      ) : state === "error" ? (
        <p className="mt-3 text-sm text-text-muted">Could not load the materials breakdown.</p>
      ) : data ? (
        <>
          <p className="mt-3 font-display text-2xl text-text" data-testid="supplier-invoices-total">
            {data.invoiceCount === 0 ? "—" : formatCentsExact(data.confirmedCents)}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {data.invoiceCount === 0
              ? "No confirmed supplier invoices yet — confirm one in the inbox and its lines appear here by category."
              : `${data.invoiceCount} confirmed ${data.invoiceCount === 1 ? "invoice" : "invoices"} · ${data.lines.length} ${data.lines.length === 1 ? "line" : "lines"}${
                  data.invoicesWithoutLines.length
                    ? ` · ${data.invoicesWithoutLines.length} unitemised`
                    : ""
                } · counted in the Money card's Materials figure.`}
          </p>

          {data.byCategory.length ? (
            <ul className="mt-3 space-y-1.5" data-testid="materials-by-category">
              {data.byCategory.map((c) => (
                <li key={c.category}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-[4px] px-1 py-0.5 text-left hover:bg-surface-subtle"
                    aria-expanded={open === c.category}
                    data-testid={`materials-category-${c.category}`}
                    onClick={() => setOpen(open === c.category ? null : c.category)}
                  >
                    <span className="w-40 shrink-0 truncate text-sm text-text">{c.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                      <span
                        className={cn(
                          "block h-2 rounded-full",
                          c.cents < 0 ? "bg-state-warning" : "bg-brand-navy",
                          pctWidthClass(Math.abs(c.cents), maxCents)
                        )}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-text">
                      {formatCentsExact(c.cents)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] text-text-muted">
                      {data.linesCents ? `${Math.round((c.cents / data.linesCents) * 100)}%` : ""}
                    </span>
                  </button>
                  {open === c.category ? (
                    <div className="mt-1 overflow-x-auto">
                      <table
                        className="w-full text-xs"
                        data-testid={`materials-lines-${c.category}`}
                      >
                        <tbody>
                          {data.lines
                            .filter((l) => l.category === c.category)
                            .map((l) => (
                              <tr key={l.id} className="border-t border-border align-top">
                                <td className="whitespace-nowrap py-1 pr-2 tabular-nums text-text-muted">
                                  {formatShortDate(l.invoiceDate)}
                                </td>
                                <td className="whitespace-nowrap py-1 pr-2 tabular-nums text-text-muted">
                                  {formatQuantity(l.quantity, l.unit)}
                                </td>
                                <td className="py-1 pr-2 text-text">
                                  {l.description}
                                  <span className="text-text-muted">
                                    {" "}
                                    · {l.supplierName ?? "Unknown supplier"}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap py-1 text-right tabular-nums text-text">
                                  <Link
                                    href={`/invoices/${encodeURIComponent(l.invoiceId)}` as Route}
                                    className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                                  >
                                    {formatCentsExact(l.signedCents)}
                                  </Link>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {data.invoicesWithoutLines.length ? (
            <p className="mt-3 text-xs text-text-muted" data-testid="materials-unitemised">
              Not itemised (lines could not be read):{" "}
              {data.invoicesWithoutLines.map((i, n) => (
                <span key={i.invoiceId}>
                  {n > 0 ? ", " : ""}
                  <Link
                    href={`/invoices/${encodeURIComponent(i.invoiceId)}` as Route}
                    className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                  >
                    {i.supplierName ?? "Unknown supplier"} {i.supplierInvoiceNumber ?? ""}
                  </Link>{" "}
                  {formatCentsExact(i.amountCents)}
                </span>
              ))}
              .
            </p>
          ) : null}

          {data.bySupplier.length > 1 ? (
            <p className="mt-2 text-xs text-text-muted" data-testid="materials-by-supplier">
              By supplier:{" "}
              {data.bySupplier
                .map((s) => `${s.supplierName} ${formatCentsExact(s.cents)}`)
                .join(" · ")}
            </p>
          ) : null}

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
