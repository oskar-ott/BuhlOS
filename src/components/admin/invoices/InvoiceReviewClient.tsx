"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import {
  archiveInvoice,
  confirmInvoice,
  correctInvoice,
  excludeInvoice,
  getInvoice,
  holdInvoice,
  setSupplierAlwaysReview,
  invoiceDocumentUrl,
  markInvoiceDuplicate,
  reassignInvoice,
  restoreInvoice,
  retryInvoice,
  searchJobs,
  selectInvoiceJob,
  type InvoiceCorrections,
} from "@/domains/invoices/client";
import { DOCUMENT_TYPES, type InvoiceDetail, type JobSummary } from "@/domains/invoices/schema";
import {
  autoBookCountdown,
  centsToDollarsInput,
  confirmBlockerLabel,
  documentTypeLabel,
  dollarsInputToCents,
  eventLabel,
  formatCentsExact,
  formatShortDate,
  excludedReasonLabel,
  reviewReasonLabel,
  statusLabel,
  statusTone,
} from "@/domains/invoices/format";
import { InvoiceUploadButton } from "./InvoiceUploadButton";

type Action = (id: string) => Promise<{ ok: true; data: InvoiceDetail } | { ok: false; error: { status: number; body: unknown } }>;

interface FormState {
  supplierName: string;
  supplierInvoiceNumber: string;
  documentType: string;
  invoiceDate: string;
  subtotal: string;
  gst: string;
  total: string;
  ivReference: string;
}

function formFrom(d: InvoiceDetail): FormState {
  const i = d.invoice;
  return {
    supplierName: i.supplierName ?? "",
    supplierInvoiceNumber: i.supplierInvoiceNumber ?? "",
    documentType: i.documentType,
    invoiceDate: i.invoiceDate ?? "",
    subtotal: centsToDollarsInput(i.subtotalCents),
    gst: centsToDollarsInput(i.gstCents),
    total: centsToDollarsInput(i.totalCents),
    ivReference: i.ivReference ?? i.ivReferenceRaw ?? "",
  };
}

function errorText(err: { status: number; body: unknown }): string {
  const code = (err.body as { error?: string; blockers?: string[]; details?: string[] } | null)?.error;
  const body = err.body as { blockers?: string[]; details?: string[] } | null;
  if (code === "cannot_confirm" && body?.blockers?.length) return body.blockers.map(confirmBlockerLabel).join(". ");
  if (code === "invalid_input" && body?.details?.length) return `Check: ${body.details.join(", ").replace(/_/g, " ")}`;
  if (code === "invalid_transition") return "That action is not available in this document's current state.";
  if (code === "job_not_found") return "That job no longer exists.";
  if (code === "already_allocated") return "This invoice is already counted against another job — use Move to another job.";
  if (code === "ivReference_malformed") return "An IV job reference is IV followed by four digits, e.g. IV0041.";
  return `That didn't work (${code ?? err.status ?? "network"}).`;
}

/**
 * Review one supplier document: original PDF beside what was read from it,
 * the exact IV match reason, corrections, job choice and the ONE confirmation
 * action. Nothing here is hidden behind a multi-step flow: Confirm is the
 * primary button whenever the server says it can be confirmed, and every
 * reason it can't is spelled out beside it.
 */
export function InvoiceReviewClient({ invoiceId }: { invoiceId: string }) {
  const ids = useId();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [jobQuery, setJobQuery] = useState("");
  const [jobOptions, setJobOptions] = useState<JobSummary[]>([]);
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const apply = useCallback((d: InvoiceDetail) => {
    setDetail(d);
    setForm(formFrom(d));
    setDirty(false);
    setState("ready");
  }, []);

  const load = useCallback(async () => {
    const res = await getInvoice(invoiceId);
    if (!res.ok) {
      setState(res.error.status === 404 ? "notfound" : "error");
      return;
    }
    apply(res.data);
  }, [invoiceId, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!jobQuery.trim()) {
      setJobOptions([]);
      return;
    }
    const t = setTimeout(() => {
      void searchJobs(jobQuery.trim()).then((r) => {
        if (r.ok) setJobOptions(r.data.jobs);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [jobQuery]);

  async function run(label: string, action: Action, okText: string) {
    setBusy(label);
    setMessage(null);
    const res = await action(invoiceId);
    setBusy(null);
    if (!res.ok) {
      setMessage({ tone: "error", text: errorText(res.error) });
      return;
    }
    apply(res.data);
    setMessage({ tone: "ok", text: okText });
  }

  async function saveCorrections() {
    if (!form || !detail) return;
    const patch: InvoiceCorrections = {};
    const i = detail.invoice;
    if (form.supplierName.trim() !== (i.supplierName ?? "")) patch.supplierName = form.supplierName.trim();
    if (form.supplierInvoiceNumber.trim() !== (i.supplierInvoiceNumber ?? "")) patch.supplierInvoiceNumber = form.supplierInvoiceNumber.trim() || null;
    if (form.documentType !== i.documentType) patch.documentType = form.documentType;
    if (form.invoiceDate !== (i.invoiceDate ?? "")) patch.invoiceDate = form.invoiceDate || null;
    const sub = dollarsInputToCents(form.subtotal);
    const gst = dollarsInputToCents(form.gst);
    const tot = dollarsInputToCents(form.total);
    if (form.subtotal.trim() && sub == null) return setMessage({ tone: "error", text: "Cost excluding GST must be a dollar amount like 184.50." });
    if (form.gst.trim() && gst == null) return setMessage({ tone: "error", text: "GST must be a dollar amount." });
    if (form.total.trim() && tot == null) return setMessage({ tone: "error", text: "Total including GST must be a dollar amount." });
    if (sub !== i.subtotalCents) patch.subtotalCents = sub;
    if (gst !== i.gstCents) patch.gstCents = gst;
    if (tot !== i.totalCents) patch.totalCents = tot;
    if (form.ivReference.trim().toUpperCase() !== (i.ivReference ?? "")) patch.ivReference = form.ivReference.trim() || null;
    if (Object.keys(patch).length === 0) {
      setDirty(false);
      return;
    }
    await run("save", (id) => correctInvoice(id, patch), "Details saved.");
  }

  if (state === "loading") {
    return <div className="h-64 animate-pulse rounded-card bg-surface-subtle" data-testid="invoice-review-skeleton" aria-busy="true" />;
  }
  if (state === "notfound") {
    return (
      <Card>
        <p className="text-sm text-text">This invoice does not exist.</p>
        <Link href="/invoices" className="mt-2 inline-block text-sm underline">
          Back to supplier invoices
        </Link>
      </Card>
    );
  }
  if (state === "error" || !detail || !form) {
    return (
      <Card>
        <p role="alert" className="text-sm text-state-danger-subtle-text">
          Could not load this invoice.
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </Card>
    );
  }

  const inv = detail.invoice;
  const active = detail.allocations.find((a) => a.status === "active") ?? null;
  const editable = ["matched", "needs_review", "failed"].includes(inv.status);
  const pdfUrl = invoiceDocumentUrl(inv.id);
  const field = (k: string) => inv.fields[k];
  const provenance = (k: string) => {
    const f = field(k);
    if (!f || !f.provenance) return null;
    const src = f.provenance === "manual" ? "entered by office" : f.provenance === "ai" ? "read by AI" : f.provenance === "derived" ? `derived (${f.label ?? ""})` : `read from PDF${f.label ? ` · ${f.label}` : ""}`;
    return `${src}${f.confidence && f.confidence !== "none" ? ` · ${f.confidence} confidence` : ""}`;
  };
  const isConfirmedElsewhere = inv.status === "confirmed";
  const reason = inv.matchReason ?? {};
  const warnings = Array.isArray(reason.warnings) ? (reason.warnings as string[]) : [];

  return (
    <div className="space-y-4" data-testid="invoice-review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-xl text-text">
            {inv.supplierName ?? "Unknown supplier"}{" "}
            <span className="text-text-muted">· {documentTypeLabel(inv.documentType)}</span>
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Supplier invoice number <span className="font-mono text-text">{inv.supplierInvoiceNumber ?? "—"}</span> · received{" "}
            {formatShortDate(inv.createdAt)} via {inv.source === "email" ? "email" : "upload"}
            {inv.sourceSubject ? ` · “${inv.sourceSubject}”` : ""}
          </p>
        </div>
        <StatusChip tone={statusTone(inv.status)} uppercase={false} data-testid="invoice-status">
          {inv.status === "confirmed" && inv.confirmedBy === "BuhlOS (auto)" ? "Booked automatically" : statusLabel(inv.status)}
        </StatusChip>
      </div>

      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={cn("rounded-[4px] border px-3 py-2 text-sm", message.tone === "error" ? "border-state-danger text-state-danger-subtle-text" : "border-border text-text")}
        >
          {message.text}
        </p>
      ) : null}

      {inv.status === "excluded" && excludedReasonLabel(inv.excludedReason)?.startsWith("Set aside") ? (
        <Card className="border-l-4 border-l-border" data-testid="invoice-set-aside">
          <CardKicker>Set aside</CardKicker>
          <p className="mt-2 text-sm text-text">
            {excludedReasonLabel(inv.excludedReason)}. Nothing was booked. If this really is an invoice, restore it and correct the document type.
          </p>
        </Card>
      ) : null}

      {inv.reviewReasons.length > 0 && !["confirmed", "excluded", "archived", "duplicate"].includes(inv.status) ? (
        <Card className="border-l-4 border-l-accent-yellow">
          <CardKicker>Why this needs you</CardKicker>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text" data-testid="invoice-review-reasons">
            {inv.reviewReasons.map((r) => (
              <li key={r}>{reviewReasonLabel(r)}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {inv.status === "matched" || (inv.status === "confirmed" && inv.confirmedBy === "BuhlOS (auto)") ? (
        <Card className={cn(inv.autoConfirmAt && !inv.heldAt ? "border-l-4 border-l-brand-navy" : "")} data-testid="invoice-auto-booking">
          <CardKicker>Automatic booking</CardKicker>
          {inv.status === "confirmed" ? (
            <p className="mt-2 text-sm text-text">
              Booked by BuhlOS on {formatShortDate(inv.confirmedAt)} because every check passed. Wrong? Use Move, Exclude or Archive below — the cost reverses.
            </p>
          ) : inv.heldAt ? (
            <p className="mt-2 text-sm text-text">On hold by {inv.heldBy ?? "a person"} since {formatShortDate(inv.heldAt)} — it will not book itself.</p>
          ) : inv.autoConfirmAt ? (
            <p className="mt-2 text-sm text-text" data-testid="invoice-auto-countdown">{autoBookCountdown(inv.autoConfirmAt)}.</p>
          ) : inv.autoConfirmEligible ? (
            <p className="mt-2 text-sm text-text">Every check passes — this would book itself if automatic booking were switched on.</p>
          ) : (
            <p className="mt-2 text-sm text-text">Waits for a person: {inv.autoConfirmChecks.filter((c) => !c.ok).map((c) => c.label ?? c.code).join("; ") || "checks not yet run"}.</p>
          )}
          {inv.autoConfirmChecks.length ? (
            <details className="mt-2 text-xs text-text-muted">
              <summary className="cursor-pointer">Checks</summary>
              <ul className="mt-1 space-y-0.5">
                {inv.autoConfirmChecks.map((c) => (
                  <li key={c.code}>{c.ok ? "✓" : "✗"} {c.label ?? c.code}{c.detail ? ` — ${c.detail}` : ""}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {inv.status === "matched" && inv.autoConfirmAt && !inv.heldAt ? (
              <Button type="button" variant="secondary" size="sm" disabled={busy !== null} data-testid="invoice-hold" onClick={() => void run("hold", (id) => holdInvoice(id), "Held — it will wait for a person.")}>
                Hold &mdash; don&rsquo;t book automatically
              </Button>
            ) : null}
            {inv.supplierKey ? (
              <label className="inline-flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={detail.supplierPref.alwaysReview}
                  disabled={busy !== null}
                  data-testid="invoice-supplier-always-review"
                  onChange={(e) => void run("pref", (id) => setSupplierAlwaysReview(id, e.target.checked), e.target.checked ? "This supplier will always wait for a person." : "This supplier can book automatically again.")}
                />
                Always review invoices from {inv.supplierName ?? "this supplier"}
              </label>
            ) : null}
          </div>
        </Card>
      ) : null}

      {inv.status === "duplicate" ? (
        <Card>
          <CardKicker>Duplicate</CardKicker>
          <p className="mt-2 text-sm text-text">
            This looks like the same document as{" "}
            {detail.duplicateOf ? (
              <Link href={`/invoices/${encodeURIComponent(detail.duplicateOf.id)}` as Route} className="underline">
                {detail.duplicateOf.supplierName ?? "an earlier invoice"} {detail.duplicateOf.supplierInvoiceNumber ?? ""}
              </Link>
            ) : (
              "an earlier invoice"
            )}{" "}
            ({inv.duplicateReason === "checksum" ? "identical file" : inv.duplicateReason === "supplier_invoice_number" ? "same supplier and invoice number" : "marked by the office"}). It is not counted anywhere.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* Left: the original document */}
        <Card className="p-3">
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <CardKicker>{detail.documents[0]?.kind === "image" ? "Original photo" : "Original PDF"}</CardKicker>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-sm underline decoration-accent-yellow decoration-2 underline-offset-2" data-testid="invoice-open-pdf">
              Open in a new tab
            </a>
          </div>
          {detail.documents.length && detail.documents[0]?.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- authed proxy URL, not an optimisable static asset
            <img
              alt="Photo of the supplier document"
              src={pdfUrl}
              className="mt-2 max-h-[60vh] w-full rounded-[4px] border border-border bg-surface object-contain"
              data-testid="invoice-image"
            />
          ) : detail.documents.length ? (
            <iframe
              title="Original supplier document"
              src={pdfUrl}
              className="mt-2 h-[60vh] w-full rounded-[4px] border border-border bg-surface"
              data-testid="invoice-pdf-frame"
            />
          ) : (
            <div className="mt-2 space-y-3 px-2" data-testid="invoice-no-document">
              <p className="text-sm text-text">No document arrived with this email.</p>
              {inv.sourceLinks.length ? (
                <div>
                  <p className="text-xs text-text-muted">Links in the email — the invoice may be behind one of these:</p>
                  <ul className="mt-1 space-y-1 text-sm">
                    {inv.sourceLinks.map((l) => (
                      <li key={l} className="truncate">
                        <a href={l} target="_blank" rel="noreferrer noopener" className="underline decoration-accent-yellow decoration-2 underline-offset-2">
                          {l}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {inv.sourceTextExcerpt ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[4px] border border-border bg-surface-subtle p-2 text-xs text-text" data-testid="invoice-email-excerpt">
                  {inv.sourceTextExcerpt}
                </pre>
              ) : null}
              {editable ? (
                <div>
                  <p className="mb-1 text-xs text-text-muted">Download the invoice from the supplier, then attach it here — BuhlOS reads and matches it straight away.</p>
                  <InvoiceUploadButton attachTo={inv.id} onAttached={apply} />
                </div>
              ) : null}
            </div>
          )}
          <p className="mt-2 px-2 text-xs text-text-muted">
            {detail.documents.map((d) => `${d.filename} · ${(d.byteSize / 1024).toFixed(0)} KB${d.pageCount ? ` · ${d.pageCount} page${d.pageCount === 1 ? "" : "s"}` : ""}${d.kind === "image" ? " · photo" : d.hasTextLayer === false ? " · no text layer" : ""}`).join(" · ")}
          </p>
        </Card>

        {/* Right: what was read + the decisions */}
        <div className="space-y-4">
          <Card>
            <CardKicker>Matched BuhlOS job</CardKicker>
            {detail.job ? (
              <p className="mt-2 text-sm text-text" data-testid="invoice-matched-job">
                <Link href={`/v2/jobs/${encodeURIComponent(detail.job.id)}` as Route} className="font-medium underline-offset-2 hover:underline">
                  {detail.job.code ? `${detail.job.code} · ` : ""}
                  {detail.job.name}
                </Link>{" "}
                <span className="text-text-muted">({detail.job.status.replace("_", " ")})</span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-text-muted">No job yet.</p>
            )}
            <p className="mt-2 text-xs text-text-muted" data-testid="invoice-match-reason">
              {inv.matchStatus === "exact" && typeof reason.normalised === "string"
                ? `Exact match: “${String(reason.raw ?? reason.normalised)}” read under “${String(reason.label ?? "an unlabelled line")}” → ${String(reason.normalised)} = this job's code (${String(reason.matchCount ?? 1)} job carries it).`
                : inv.matchStatus === "manual"
                  ? "Chosen by the office."
                  : inv.matchStatus === "ambiguous"
                    ? `${String(reason.matchCount ?? "Several")} jobs carry ${String(reason.normalised ?? "this reference")} — automatic matching was blocked.`
                    : inv.matchStatus === "not_found"
                      ? `“${String(reason.raw ?? inv.ivReference ?? "")}” → ${String(reason.normalised ?? "")} matches no job code.`
                      : inv.matchStatus === "multi_reference"
                        ? `Several different IV references were printed: ${(Array.isArray(reason.distinct) ? (reason.distinct as string[]) : []).join(", ")}.`
                        : "No IV job reference was read from the document."}
            </p>
            {inv.matchStatus === "not_found" && editable && detail.suggestions.length ? (
              <div className="mt-2" data-testid="invoice-suggestions">
                <p className="text-xs text-text-muted">Did you mean one of these? (one digit off — check the paperwork before choosing)</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {detail.suggestions.map((j) => (
                    <Button
                      key={j.id}
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      data-testid={`invoice-suggestion-${j.id}`}
                      onClick={() => void run("job", (id) => selectInvoiceJob(id, j.id), `Job chosen: ${j.code ?? j.name}.`)}
                    >
                      <span className="font-mono text-xs">{j.code}</span>&nbsp;· {j.name}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {warnings.length ? (
              <ul className="mt-2 space-y-1 text-xs text-state-warning-subtle-text">
                {warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            ) : null}
            {editable || inv.status === "confirmed" ? (
              <div className="mt-3">
                <label htmlFor={`${ids}-job`} className="block text-xs text-text-muted">
                  {inv.status === "confirmed" ? "Move to another job" : "Choose a different job"}
                </label>
                <input
                  id={`${ids}-job`}
                  value={jobQuery}
                  onChange={(e) => setJobQuery(e.target.value)}
                  placeholder="Search by name or IV code"
                  className="mt-1 h-9 w-full rounded-[4px] border border-border bg-surface px-2 text-sm"
                  data-testid="invoice-job-search"
                />
                {jobOptions.length ? (
                  <ul className="mt-1 max-h-48 overflow-y-auto rounded-[4px] border border-border bg-surface text-sm">
                    {jobOptions.map((j) => (
                      <li key={j.id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-surface-subtle"
                          disabled={busy !== null}
                          data-testid={`invoice-job-option-${j.id}`}
                          onClick={() => {
                            setJobQuery("");
                            setJobOptions([]);
                            void run(
                              "job",
                              (id) => (inv.status === "confirmed" ? reassignInvoice(id, j.id) : selectInvoiceJob(id, j.id)),
                              inv.status === "confirmed" ? "Moved to the other job — the cost moved with it." : "Job chosen."
                            );
                          }}
                        >
                          <span>
                            {j.code ? <span className="font-mono text-xs">{j.code} · </span> : null}
                            {j.name}
                          </span>
                          <span className="text-xs text-text-muted">{j.status.replace("_", " ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card>
            <CardKicker>What was read</CardKicker>
            <div className="mt-3 grid gap-3">
              <Field id={`${ids}-supplier`} label="Supplier" hint={provenance("supplierName")}>
                <input id={`${ids}-supplier`} value={form.supplierName} disabled={!editable} onChange={(e) => { setForm({ ...form, supplierName: e.target.value }); setDirty(true); }} className={inputCls} data-testid="invoice-field-supplier" />
              </Field>
              <Field id={`${ids}-number`} label="Supplier invoice number" hint={provenance("supplierInvoiceNumber")}>
                <input id={`${ids}-number`} value={form.supplierInvoiceNumber} disabled={!editable} onChange={(e) => { setForm({ ...form, supplierInvoiceNumber: e.target.value }); setDirty(true); }} className={cn(inputCls, "font-mono")} data-testid="invoice-field-number" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id={`${ids}-type`} label="Document type" hint={provenance("documentType")}>
                  <select id={`${ids}-type`} value={form.documentType} disabled={!editable} onChange={(e) => { setForm({ ...form, documentType: e.target.value }); setDirty(true); }} className={inputCls} data-testid="invoice-field-type">
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {documentTypeLabel(t)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id={`${ids}-date`} label="Invoice date" hint={provenance("invoiceDate")}>
                  <input id={`${ids}-date`} type="date" value={form.invoiceDate} disabled={!editable} onChange={(e) => { setForm({ ...form, invoiceDate: e.target.value }); setDirty(true); }} className={inputCls} data-testid="invoice-field-date" />
                </Field>
              </div>
              <Field id={`${ids}-iv`} label="IV job reference" hint={provenance("ivReference") ?? "The job code the wholesaler printed (IV + four digits) — not the invoice number"}>
                <input id={`${ids}-iv`} value={form.ivReference} disabled={!editable} onChange={(e) => { setForm({ ...form, ivReference: e.target.value }); setDirty(true); }} placeholder="IV0041" className={cn(inputCls, "font-mono uppercase")} data-testid="invoice-field-iv" />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field id={`${ids}-sub`} label="Cost excluding GST" hint={provenance("subtotalCents")}>
                  <input id={`${ids}-sub`} inputMode="decimal" value={form.subtotal} disabled={!editable} onChange={(e) => { setForm({ ...form, subtotal: e.target.value }); setDirty(true); }} className={cn(inputCls, "font-mono")} data-testid="invoice-field-subtotal" />
                </Field>
                <Field id={`${ids}-gst`} label="GST" hint={provenance("gstCents")}>
                  <input id={`${ids}-gst`} inputMode="decimal" value={form.gst} disabled={!editable} onChange={(e) => { setForm({ ...form, gst: e.target.value }); setDirty(true); }} className={cn(inputCls, "font-mono")} data-testid="invoice-field-gst" />
                </Field>
                <Field id={`${ids}-tot`} label="Total including GST" hint={provenance("totalCents")}>
                  <input id={`${ids}-tot`} inputMode="decimal" value={form.total} disabled={!editable} onChange={(e) => { setForm({ ...form, total: e.target.value }); setDirty(true); }} className={cn(inputCls, "font-mono")} data-testid="invoice-field-total" />
                </Field>
              </div>
              {inv.totalsConsistent === false ? (
                <p className="text-xs text-state-danger-subtle-text">Ex-GST + GST does not equal the total as printed. Correct the figures to match the document.</p>
              ) : inv.totalsConsistent === true && field("gstCents")?.provenance === "derived" ? (
                <p className="text-xs text-text-muted">GST was derived as total − ex-GST (the document printed only two of the three figures).</p>
              ) : null}
              {editable ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy !== null} onClick={() => void saveCorrections()} data-testid="invoice-save">
                    {busy === "save" ? "Saving…" : "Save corrections"}
                  </Button>
                  {dirty ? <span className="text-xs text-text-muted">Unsaved changes</span> : null}
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardKicker>Cost on the job</CardKicker>
            {active ? (
              <p className="mt-2 text-sm text-text" data-testid="invoice-allocation">
                {active.amountCents < 0 ? "Credit of " : ""}
                <span className="font-mono">{formatCentsExact(Math.abs(active.amountCents))}</span> excluding GST on{" "}
                <span className="font-medium">{detail.job ? `${detail.job.code ? `${detail.job.code} · ` : ""}${detail.job.name}` : active.jobId}</span>, confirmed by {active.confirmedBy ?? "—"} on {formatShortDate(active.confirmedAt)}.
                {active.gstCents != null ? ` GST ${formatCentsExact(active.gstCents)} · total ${formatCentsExact(active.totalCents)} (recorded, not costed).` : ""}
              </p>
            ) : inv.status === "confirmed" ? (
              <p className="mt-2 text-sm text-text-muted">Confirmed, no active allocation.</p>
            ) : (
              <>
                <p className="mt-2 text-sm text-text-muted">
                  {inv.documentType === "credit_note"
                    ? `Confirming records a credit of ${formatCentsExact(inv.subtotalCents)} (excluding GST) against the job.`
                    : `Confirming adds ${formatCentsExact(inv.subtotalCents)} (excluding GST) to the job's supplier-invoice cost. GST and the total are kept for the record, not costed.`}
                </p>
                {!detail.canConfirm && !["excluded", "archived", "duplicate"].includes(inv.status) ? (
                  <ul className="mt-2 space-y-1 text-xs text-text-muted" data-testid="invoice-confirm-blockers">
                    {detail.confirmBlockers.filter((b) => b !== "status").map((b) => (
                      <li key={b}>· {confirmBlockerLabel(b)}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {!isConfirmedElsewhere && !["excluded", "archived", "duplicate"].includes(inv.status) ? (
                <Button type="button" variant="primary" size="sm" disabled={!detail.canConfirm || busy !== null || dirty} data-testid="invoice-confirm" onClick={() => void run("confirm", (id) => confirmInvoice(id), "Confirmed — the cost is now on the job.")}>
                  {busy === "confirm" ? "Confirming…" : inv.documentType === "credit_note" ? "Confirm credit on this job" : "Confirm cost on this job"}
                </Button>
              ) : null}
              {["matched", "needs_review", "failed"].includes(inv.status) ? (
                <Button type="button" variant="secondary" size="sm" disabled={busy !== null} data-testid="invoice-mark-duplicate" onClick={() => void run("dup", (id) => markInvoiceDuplicate(id), "Marked as a duplicate.")}>
                  Mark as duplicate
                </Button>
              ) : null}
              {["matched", "needs_review", "failed", "confirmed", "duplicate"].includes(inv.status) ? (
                confirmExclude ? (
                  <span className="inline-flex items-center gap-2 text-xs">
                    {inv.status === "confirmed" ? "This removes the cost from the job." : "Statements, quotes and unrelated documents belong here."}
                    <Button type="button" variant="danger" size="sm" disabled={busy !== null} data-testid="invoice-exclude-confirm" onClick={() => { setConfirmExclude(false); void run("exclude", (id) => excludeInvoice(id), "Excluded — it is not a job cost."); }}>
                      Yes, exclude
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmExclude(false)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button type="button" variant="secondary" size="sm" disabled={busy !== null} data-testid="invoice-exclude" onClick={() => setConfirmExclude(true)}>
                    Exclude (statement / quote / not ours)
                  </Button>
                )
              ) : null}
              {["failed", "needs_review", "matched"].includes(inv.status) ? (
                <Button type="button" variant="ghost" size="sm" disabled={busy !== null} data-testid="invoice-retry" onClick={() => void run("retry", (id) => retryInvoice(id), "Re-read the document.")}>
                  {busy === "retry" ? "Reading…" : "Re-read the document"}
                </Button>
              ) : null}
              {["duplicate", "excluded", "archived"].includes(inv.status) ? (
                <Button type="button" variant="secondary" size="sm" disabled={busy !== null} data-testid="invoice-restore" onClick={() => void run("restore", (id) => restoreInvoice(id), "Restored to review.")}>
                  Restore to review
                </Button>
              ) : null}
              {!["archived"].includes(inv.status) ? (
                confirmArchive ? (
                  <span className="inline-flex items-center gap-2 text-xs">
                    {inv.status === "confirmed" ? "Archiving reverses the cost on the job. The PDF and history are kept." : "The PDF and history are kept; you can restore it."}
                    <Button type="button" variant="danger" size="sm" disabled={busy !== null} data-testid="invoice-archive-confirm" onClick={() => { setConfirmArchive(false); void run("archive", (id) => archiveInvoice(id), "Archived."); }}>
                      Yes, archive
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmArchive(false)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button type="button" variant="ghost" size="sm" disabled={busy !== null} data-testid="invoice-archive" onClick={() => setConfirmArchive(true)}>
                    Archive
                  </Button>
                )
              ) : null}
            </div>
          </Card>

          <Card>
            <CardKicker>History</CardKicker>
            <ol className="mt-2 space-y-1 text-xs text-text-muted" data-testid="invoice-history">
              {detail.events.map((e) => (
                <li key={e.id}>
                  <span className="text-text">{eventLabel(e.event)}</span>
                  {e.actor ? ` · ${e.actor}` : ""} · {formatShortDate(e.at)}
                  {e.event === "attempt_failed" || e.event === "failed" ? ` · ${String((e.detail as { code?: string }).code ?? "")}` : ""}
                </li>
              ))}
              {detail.allocations.filter((a) => a.status === "reversed").map((a) => (
                <li key={a.id}>
                  <span className="text-text">Cost of {formatCentsExact(Math.abs(a.amountCents))} on {a.jobId} reversed</span>
                  {a.reversedBy ? ` · ${a.reversedBy}` : ""} · {formatShortDate(a.reversedAt)}
                  {a.reversalReason ? ` · ${a.reversalReason}` : ""}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

const inputCls = "h-9 w-full rounded-[4px] border border-border bg-surface px-2 text-sm text-text disabled:bg-surface-subtle disabled:text-text-muted";

function Field({ id, label, hint, children }: { id: string; label: string; hint: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p> : null}
    </div>
  );
}
