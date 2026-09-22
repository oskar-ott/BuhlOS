"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Seg } from "@/components/ui/Seg";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import { invoiceSetup, listInvoices, processPending } from "@/domains/invoices/client";
import type { Invoice, InvoiceList, InvoiceSetup } from "@/domains/invoices/schema";
import {
  documentTypeLabel,
  formatCentsExact,
  formatShortDate,
  autoBookCountdown,
  statusLabel,
  statusTone,
} from "@/domains/invoices/format";
import { InvoiceUploadButton } from "./InvoiceUploadButton";

type Filter = "review" | "soon" | "matched" | "confirmed" | "duplicate" | "failed" | "excluded" | "all";

const FILTER_STATUSES: Record<Filter, string[]> = {
  review: ["needs_review", "received", "processing"],
  soon: ["matched"],
  matched: ["matched"],
  confirmed: ["confirmed"],
  duplicate: ["duplicate"],
  failed: ["failed"],
  excluded: ["excluded", "archived"],
  all: [],
};

function filterFromStatus(status: string | undefined): Filter {
  if (!status) return "review";
  for (const [k, v] of Object.entries(FILTER_STATUSES)) if (v.includes(status)) return k as Filter;
  return "all";
}

const PAGE_SIZE = 25;

/**
 * The supplier-invoice inbox. One fetch per filter change over /api/invoices
 * (paginated, never unbounded). Rows waiting to be read (`received`) are
 * processed on mount through ?action=process-pending so the office rarely
 * waits for the 15-minute sweep. Desktop: a scrollable table; phones: cards.
 * Honest states throughout — loading skeleton, real errors with retry, an
 * empty state that says what will appear and how.
 */
export function InvoiceInboxClient({
  initialJobId,
  initialStatus,
}: {
  initialJobId?: string;
  initialStatus?: string;
}) {
  const [filter, setFilter] = useState<Filter>(filterFromStatus(initialStatus));
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState("");
  const [jobId, setJobId] = useState(initialJobId ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InvoiceList | null>(null);
  const [setup, setSetup] = useState<InvoiceSetup | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    const res = await listInvoices({
      status: FILTER_STATUSES[filter],
      autoConfirm: filter === "soon" ? "pending" : undefined,
      q: q || undefined,
      supplier: supplier || undefined,
      jobId: jobId || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      limit: PAGE_SIZE,
    });
    if (!res.ok) {
      setState("error");
      setErrorMessage(
        res.error.status === 503
          ? "The invoice store is not available right now."
          : `Could not load invoices (${res.error.status || "network"}).`
      );
      return;
    }
    setData(res.data);
    setState("ready");
  }, [filter, q, supplier, jobId, from, to, page]);

  useEffect(() => {
    setState("loading");
    void load();
  }, [load]);

  useEffect(() => {
    void invoiceSetup().then((r) => {
      if (r.ok) setSetup(r.data);
    });
  }, []);

  // Anything still waiting to be read: process it now, then refresh once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await invoiceSetup();
      if (!r.ok || cancelled || r.data.pending === 0) return;
      setProcessing(true);
      await processPending();
      if (cancelled) return;
      setProcessing(false);
      void load();
    })();
    return () => {
      cancelled = true;
    };
    // run once on mount — later reads come from explicit actions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = data?.counts ?? {};
  const countFor = (f: Filter) =>
    FILTER_STATUSES[f].reduce((n, s) => n + (counts[s] ?? 0), 0) || undefined;
  const segOptions = useMemo(
    () => [
      { value: "review" as Filter, label: "Needs review", count: countFor("review") },
      { value: "soon" as Filter, label: "Booking soon", count: data?.autoConfirmPendingCount || undefined },
      { value: "matched" as Filter, label: "Matched", count: countFor("matched") },
      { value: "confirmed" as Filter, label: "Confirmed", count: countFor("confirmed") },
      { value: "duplicate" as Filter, label: "Duplicate", count: countFor("duplicate") },
      { value: "failed" as Filter, label: "Failed", count: countFor("failed") },
      { value: "excluded" as Filter, label: "Excluded", count: countFor("excluded") },
      { value: "all" as Filter, label: "All" },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="space-y-4" data-testid="invoice-inbox">
      <SetupCard setup={setup} processing={processing} onUploaded={() => void load()} />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Seg<Filter>
            aria-label="Invoice status"
            options={segOptions}
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPage(1);
            }}
          />
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search supplier, invoice number, IV reference"
            aria-label="Search invoices"
            className="h-9 w-full rounded-[4px] border border-border bg-surface px-3 text-sm sm:w-80"
            data-testid="invoice-search"
          />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <select
            aria-label="Supplier"
            value={supplier}
            onChange={(e) => {
              setSupplier(e.target.value);
              setPage(1);
            }}
            className="h-9 rounded-[4px] border border-border bg-surface px-2 text-sm"
          >
            <option value="">All suppliers</option>
            {(data?.suppliers ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {s.name ?? s.key} ({s.count})
              </option>
            ))}
          </select>
          <input
            aria-label="Job"
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value.trim());
              setPage(1);
            }}
            placeholder="Job id"
            className="h-9 rounded-[4px] border border-border bg-surface px-2 text-sm"
          />
          <input
            type="date"
            aria-label="From date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="h-9 rounded-[4px] border border-border bg-surface px-2 text-sm"
          />
          <input
            type="date"
            aria-label="To date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="h-9 rounded-[4px] border border-border bg-surface px-2 text-sm"
          />
        </div>
      </Card>

      {state === "loading" && !data ? (
        <div className="space-y-2" data-testid="invoice-inbox-skeleton" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-card bg-surface-subtle" />
          ))}
        </div>
      ) : state === "error" ? (
        <Card>
          <p role="alert" className="text-sm text-state-danger-subtle-text">
            {errorMessage}
          </p>
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      ) : data && data.invoices.length === 0 ? (
        <EmptyState
          title={filter === "review" ? "Nothing to review" : filter === "soon" ? "Nothing is waiting to book itself" : "No invoices here"}
          description={
            filter === "review"
              ? "Invoices forwarded to the inbound address, or uploaded above, appear here once they have been read. Each one is matched to a job by the IV reference the wholesaler printed."
              : "Change the filter or search to find what you are after."
          }
        />
      ) : data ? (
        <>
          <InvoiceTable invoices={data.invoices} jobsById={data.jobsById} />
          <InvoiceCards invoices={data.invoices} jobsById={data.jobsById} />
          {totalPages > 1 ? (
            <div className="flex items-center justify-between text-sm text-text-muted">
              <span>
                Page {data.page} of {totalPages} · {data.total} invoice{data.total === 1 ? "" : "s"}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SetupCard({
  setup,
  processing,
  onUploaded,
}: {
  setup: InvoiceSetup | null;
  processing: boolean;
  onUploaded: () => void;
}) {
  const inbound = setup?.inbound;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <CardKicker>Inbound email</CardKicker>
          {!setup ? (
            <p className="mt-2 text-sm text-text-muted">Checking the inbound set-up…</p>
          ) : inbound?.configured && inbound.address ? (
            <>
              <p className="mt-2 text-sm text-text">
                Forward supplier invoices to{" "}
                <code className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs" data-testid="invoice-inbound-address">
                  {inbound.address}
                </code>
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Set a rule in the office mailbox that forwards wholesaler emails there. PDF attachments
                are captured; the email itself is only supporting evidence.
                {inbound.quarantinedWaiting ? " Emails received while this feature was off will be picked up by the next sweep." : ""}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-text-muted">
              Inbound email is not set up yet — upload PDFs here in the meantime. Missing:{" "}
              {[
                !inbound?.webhookSecretSet && "webhook secret",
                !inbound?.apiKeySet && "Resend API key",
                !inbound?.domainSet && "inbound domain",
              ]
                .filter(Boolean)
                .join(", ") || "nothing — waiting on the first delivery"}
              .
            </p>
          )}
          {setup?.autoConfirm ? (
            <p className="mt-2 text-xs text-text-muted" data-testid="invoice-auto-confirm-state">
              {setup.autoConfirm.enabled
                ? `Clean invoices book themselves after ${setup.autoConfirm.graceHours}h (cap ${formatCentsExact(setup.autoConfirm.capCents)} ex GST). Hold any from its page.`
                : "Automatic booking is off — every invoice waits for a person. Clean ones are marked “would book itself” so you can see how often that would happen."}
            </p>
          ) : null}
          {processing ? (
            <p className="mt-2 text-xs text-text-muted" aria-live="polite">
              Reading new invoices…
            </p>
          ) : null}
        </div>
        <InvoiceUploadButton maxBytes={setup?.maxUploadBytes} onUploaded={onUploaded} />
      </div>
    </Card>
  );
}

function jobLabel(inv: Invoice, jobsById: InvoiceList["jobsById"]): string {
  if (!inv.matchedJobId) return "—";
  const j = jobsById[inv.matchedJobId];
  return j ? `${j.code ? `${j.code} · ` : ""}${j.name}` : inv.matchedJobId;
}

function InvoiceTable({ invoices, jobsById }: { invoices: Invoice[]; jobsById: InvoiceList["jobsById"] }) {
  return (
    <div className="hidden overflow-x-auto rounded-card border border-border bg-surface-raised md:block">
      <table className="w-full text-sm" data-testid="invoice-table">
        <thead className="bg-surface-subtle text-left font-mono text-[11px] uppercase tracking-[0.08em] text-text-muted">
          <tr>
            <th className="px-3 py-2">Supplier</th>
            <th className="px-3 py-2">Supplier invoice number</th>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">IV job reference</th>
            <th className="px-3 py-2">Matched BuhlOS job</th>
            <th className="px-3 py-2 text-right">Cost ex GST</th>
            <th className="px-3 py-2 text-right">GST</th>
            <th className="px-3 py-2 text-right">Total inc GST</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} className="border-t border-border hover:bg-surface-subtle">
              <td className="px-3 py-2">
                <Link href={`/invoices/${encodeURIComponent(inv.id)}` as Route} className="font-medium text-text underline-offset-2 hover:underline">
                  {inv.supplierName ?? <span className="text-text-muted">Unknown supplier</span>}
                </Link>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{inv.supplierInvoiceNumber ?? "—"}</td>
              <td className="px-3 py-2 whitespace-nowrap">{formatShortDate(inv.invoiceDate)}</td>
              <td className="px-3 py-2 font-mono text-xs">{inv.ivReference ?? "—"}</td>
              <td className="px-3 py-2">{jobLabel(inv, jobsById)}</td>
              <td className={cn("px-3 py-2 text-right font-mono text-xs", inv.documentType === "credit_note" && "text-state-danger-subtle-text")}>
                {inv.documentType === "credit_note" && inv.subtotalCents != null ? "-" : ""}
                {formatCentsExact(inv.subtotalCents)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{formatCentsExact(inv.gstCents)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{formatCentsExact(inv.totalCents)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{documentTypeLabel(inv.documentType)}</td>
              <td className="px-3 py-2">
                <StatusChip tone={statusTone(inv.status)} uppercase={false}>
                  {inv.status === "confirmed" && inv.confirmedBy === "BuhlOS (auto)" ? "Booked automatically" : statusLabel(inv.status)}
                </StatusChip>
                {inv.status === "matched" && inv.autoConfirmAt && !inv.heldAt ? (
                  <p className="mt-1 text-[11px] text-text-muted">{autoBookCountdown(inv.autoConfirmAt)}</p>
                ) : inv.heldAt ? (
                  <p className="mt-1 text-[11px] text-text-muted">On hold</p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceCards({ invoices, jobsById }: { invoices: Invoice[]; jobsById: InvoiceList["jobsById"] }) {
  return (
    <ul className="space-y-2 md:hidden" data-testid="invoice-cards">
      {invoices.map((inv) => (
        <li key={inv.id}>
          <Link
            href={`/invoices/${encodeURIComponent(inv.id)}` as Route}
            className="block rounded-card border border-border bg-surface-raised p-4 shadow-card"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-text">{inv.supplierName ?? "Unknown supplier"}</span>
              <StatusChip tone={statusTone(inv.status)} uppercase={false}>
                {inv.status === "confirmed" && inv.confirmedBy === "BuhlOS (auto)" ? "Booked automatically" : statusLabel(inv.status)}
              </StatusChip>
            </div>
            {inv.status === "matched" && inv.autoConfirmAt && !inv.heldAt ? (
              <p className="mt-1 text-[11px] text-text-muted">{autoBookCountdown(inv.autoConfirmAt)}</p>
            ) : null}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
              <dt>Supplier invoice number</dt>
              <dd className="font-mono text-text">{inv.supplierInvoiceNumber ?? "—"}</dd>
              <dt>IV job reference</dt>
              <dd className="font-mono text-text">{inv.ivReference ?? "—"}</dd>
              <dt>Matched BuhlOS job</dt>
              <dd className="text-text">{jobLabel(inv, jobsById)}</dd>
              <dt>Cost ex GST</dt>
              <dd className="font-mono text-text">
                {inv.documentType === "credit_note" && inv.subtotalCents != null ? "-" : ""}
                {formatCentsExact(inv.subtotalCents)}
              </dd>
              <dt>Total inc GST</dt>
              <dd className="font-mono text-text">{formatCentsExact(inv.totalCents)}</dd>
              <dt>Date · type</dt>
              <dd className="text-text">
                {formatShortDate(inv.invoiceDate)} · {documentTypeLabel(inv.documentType)}
              </dd>
            </dl>
          </Link>
        </li>
      ))}
    </ul>
  );
}
