"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { pctWidthClass } from "@/components/admin/pct-width";
import { jobMaterialsBreakdown } from "@/domains/invoices/client";
import type { JobMaterialsBreakdown, MaterialCategory } from "@/domains/invoices/schema";
import {
  formatCentsExact,
  formatMeasureMap,
  formatQuantity,
  formatShortDate,
} from "@/domains/invoices/format";

/**
 * Admin job hub — Materials used (invoice_capture, dark). Owner pull
 * 2026-09-24: "see all the materials used on a job and a breakdown — cable,
 * fixings, lights", then "click on cable and see exactly how much cable has
 * been used". Three levels, each a click:
 *   category  → "Cable · $537 · 450 m across 2 products"
 *   product   → "2.5mm TPS 100m roll · 300 m (3 rolls) · 2 invoices · $537"
 *   lines     → date · qty · supplier · amount (linked to the invoice)
 * The measure (metres, pieces) is worked out from qty × the length or pack
 * size printed in the description; lines with no such token count as
 * unmeasured and are said so, never guessed.
 *
 * Everything comes from CONFIRMED supplier invoices (active allocations,
 * credit notes negative). Invoices whose lines could not be read are listed
 * as unitemised so the breakdown never claims more than it knows. Hides
 * itself on a 403/404 rather than show a money surface to a non-admin.
 */
export function JobSupplierInvoicesCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobMaterialsBreakdown | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [openCategory, setOpenCategory] = useState<MaterialCategory | null>(null);
  const [openProduct, setOpenProduct] = useState<string | null>(null);

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
  const lineById = new Map((data?.lines ?? []).map((l) => [l.id, l]));

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
                } · counted in the Money card's Materials figure. Click a category, then a product.`}
          </p>

          {data.byCategory.length ? (
            <ul className="mt-3 space-y-1.5" data-testid="materials-by-category">
              {data.byCategory.map((c) => {
                const isOpen = openCategory === c.category;
                const measure = formatMeasureMap(c.measure);
                return (
                  <li
                    key={c.category}
                    className={cn(isOpen && "rounded-[4px] bg-surface-subtle/60 pb-2")}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[4px] px-1 py-1 text-left hover:bg-surface-subtle"
                      aria-expanded={isOpen}
                      data-testid={`materials-category-${c.category}`}
                      onClick={() => {
                        setOpenCategory(isOpen ? null : c.category);
                        setOpenProduct(null);
                      }}
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

                    {isOpen ? (
                      <div className="px-1" data-testid={`materials-products-${c.category}`}>
                        <p
                          className="mt-1 text-sm text-text"
                          data-testid={`materials-measure-${c.category}`}
                        >
                          {measure ? (
                            <>
                              <span className="font-semibold">{measure}</span> of{" "}
                              {c.label.toLowerCase()} across {c.products.length}{" "}
                              {c.products.length === 1 ? "product" : "products"}
                              {c.unmeasuredLines
                                ? ` (${c.unmeasuredLines} ${c.unmeasuredLines === 1 ? "line" : "lines"} without a readable size, not counted in that figure)`
                                : ""}
                              .
                            </>
                          ) : (
                            <>
                              {c.products.length} {c.products.length === 1 ? "product" : "products"}
                              , {c.lineCount} {c.lineCount === 1 ? "line" : "lines"} — no sizes
                              could be read from the descriptions.
                            </>
                          )}
                        </p>
                        <ul className="mt-1.5 space-y-1">
                          {c.products.map((p) => {
                            const pOpen = openProduct === p.key;
                            const pMeasure = formatMeasureMap(p.measures);
                            const pQty = formatMeasureMap(p.quantities);
                            return (
                              <li
                                key={p.key}
                                className="rounded-[4px] border border-border bg-surface"
                              >
                                <button
                                  type="button"
                                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1.5 text-left hover:bg-surface-subtle"
                                  aria-expanded={pOpen}
                                  data-testid="materials-product"
                                  onClick={() => setOpenProduct(pOpen ? null : p.key)}
                                >
                                  <span className="min-w-0 flex-1 text-sm text-text">
                                    {p.description}
                                    <span className="text-text-muted">
                                      {" "}
                                      · {p.supplierName ?? "Unknown supplier"}
                                    </span>
                                  </span>
                                  <span className="text-sm font-semibold tabular-nums text-text">
                                    {pMeasure || pQty || "—"}
                                  </span>
                                  {pMeasure && pQty && pMeasure !== pQty ? (
                                    <span className="text-xs text-text-muted">({pQty})</span>
                                  ) : null}
                                  <span className="text-xs text-text-muted">
                                    {p.invoiceCount} {p.invoiceCount === 1 ? "invoice" : "invoices"}
                                  </span>
                                  <span className="font-mono text-xs tabular-nums text-text">
                                    {formatCentsExact(p.cents)}
                                  </span>
                                </button>
                                {pOpen ? (
                                  <div className="overflow-x-auto border-t border-border">
                                    <table
                                      className="w-full text-xs"
                                      data-testid="materials-product-lines"
                                    >
                                      <tbody>
                                        {p.lineIds.map((id) => {
                                          const l = lineById.get(id);
                                          if (!l) return null;
                                          return (
                                            <tr
                                              key={id}
                                              className="border-t border-border first:border-t-0 align-top"
                                            >
                                              <td className="whitespace-nowrap py-1 pl-2 pr-2 tabular-nums text-text-muted">
                                                {formatShortDate(l.invoiceDate)}
                                              </td>
                                              <td className="whitespace-nowrap py-1 pr-2 tabular-nums text-text">
                                                {formatQuantity(l.quantity, l.unit)}
                                                {l.measure.explain ? (
                                                  <span className="text-text-muted">
                                                    {" "}
                                                    = {l.measure.amount} {l.measure.unit}
                                                  </span>
                                                ) : null}
                                              </td>
                                              <td className="py-1 pr-2 text-text-muted">
                                                {l.supplierName ?? "Unknown supplier"}{" "}
                                                {l.supplierInvoiceNumber ?? ""}
                                                {l.documentType === "credit_note"
                                                  ? " · credit note"
                                                  : ""}
                                              </td>
                                              <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-text">
                                                <Link
                                                  href={
                                                    `/invoices/${encodeURIComponent(l.invoiceId)}` as Route
                                                  }
                                                  className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                                                >
                                                  {formatCentsExact(l.signedCents)}
                                                </Link>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
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
