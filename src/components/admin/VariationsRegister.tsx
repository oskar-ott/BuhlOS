"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  approveVariationClaim,
  fetchVariationClaims,
  invoiceVariationClaim,
  quoteVariationClaim,
  raiseVariationClaim,
  rejectVariationClaim,
  reviseVariationClaim,
  submitVariationClaim,
  updateVariationClaim,
} from "@/domains/variations/client";
import {
  canTransitionClaimStatus,
  isApprovalEvidenceComplete,
  summariseVariationClaims,
} from "@/domains/variations/claim-service";
import {
  formatClaimValue,
  variationApprovalMethodLabel,
  variationClaimStatusLabel,
} from "@/domains/variations/claim-format";
import {
  VARIATION_APPROVAL_METHODS,
  VARIATION_CLAIM_LIMITS,
  VARIATION_CLAIM_STATUSES,
} from "@/domains/variations/claim-schema";
import type {
  VariationApprovalMethod,
  VariationClaimRecord,
  VariationClaimStatus,
} from "@/domains/variations/claim-types";
import { dollarsToCents } from "@/domains/cost-rates/schema";

/**
 * The per-job variation-claims register (#280): the billable record of extra
 * work — raise it, price it, submit it to the builder, and never let one reach
 * `approved` without evidence of who said yes.
 *
 * MONEY (P7): valueCents is integer cents in ALL state and on the wire. The
 * raise/price inputs take dollars and parse via dollarsToCents at the boundary
 * (reject anything that isn't money — no NaN, no float math); display goes
 * through formatClaimValue at render only.
 *
 * The action set per claim is DRIVEN by the domain transition table
 * (canTransitionClaimStatus — the same pure logic api/variations.js mirrors),
 * so the UI can't offer a move the server would refuse. The approval modal
 * mirrors the server's evidence gate client-side (isApprovalEvidenceComplete)
 * but the server's 400/409 stays the truth.
 */
type Filter = "all" | VariationClaimStatus;

/** Inline per-claim action panel: reject wants a note, invoice wants the
 *  manual invoice reference, price edits the draft's value. */
type PanelKind = "reject" | "invoice" | "price";

export function VariationsRegister({
  jobId,
  initialClaims,
  fetchError,
}: {
  jobId: string;
  initialClaims: VariationClaimRecord[];
  fetchError: string | null;
}) {
  const [claims, setClaims] = useState<VariationClaimRecord[]>(initialClaims);
  const [error, setError] = useState<string | null>(fetchError);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // Raise form.
  const [scope, setScope] = useState("");
  const [description, setDescription] = useState("");
  const [valueDollars, setValueDollars] = useState("");
  const [valueError, setValueError] = useState<string | null>(null);

  // Inline per-claim panel ({id, kind} + the text being typed).
  const [panel, setPanel] = useState<{ id: string; kind: PanelKind } | null>(null);
  const [draft, setDraft] = useState("");

  // Approval-evidence modal — the ONE way a claim reaches `approved`.
  const [approving, setApproving] = useState<VariationClaimRecord | null>(null);

  const rollup = useMemo(() => summariseVariationClaims(claims), [claims]);

  async function refresh() {
    setClaims((await fetchVariationClaims(jobId)).claims);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function onRaise(e: FormEvent) {
    e.preventDefault();
    if (!scope.trim()) return;
    // Parse dollars → integer cents at the boundary. Blank = not priced yet
    // (an honest null, never a fake $0).
    let valueCents: number | null = null;
    if (valueDollars.trim()) {
      valueCents = dollarsToCents(valueDollars);
      if (valueCents == null) {
        setValueError("Enter a dollar value like 1250 or 1250.50 — or leave it blank until priced.");
        return;
      }
    }
    setValueError(null);
    await run(async () => {
      await raiseVariationClaim(jobId, {
        scope: scope.trim(),
        description: description.trim() || null,
        valueCents,
      });
      setScope("");
      setDescription("");
      setValueDollars("");
    });
  }

  const shown = claims.filter((c) => (filter === "all" ? true : c.status === filter));
  const FILTERS: Filter[] = ["all", ...VARIATION_CLAIM_STATUSES];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Variations</h1>
        <p className="text-sm text-slate-500">
          Extra work outside the contract — every claim priced, submitted and chased here, so a
          missed variation can&rsquo;t become free work. A claim only counts as approved once
          who-said-yes is on the record.
        </p>
      </header>

      {/* Money rollup — pure integer-cents sums from the domain function. */}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryTile
          label="In flight"
          cents={rollup.openCents}
          count={rollup.counts.draft + rollup.counts.quoted + rollup.counts.submitted}
        />
        <SummaryTile label="Approved" cents={rollup.approvedCents} count={rollup.counts.approved} />
        <SummaryTile label="Invoiced" cents={rollup.invoicedCents} count={rollup.counts.invoiced} />
        <SummaryTile label="Lost" cents={rollup.lostCents} count={rollup.counts.rejected} />
      </dl>

      {error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Raise */}
      <form onSubmit={onRaise} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Scope</span>
            <input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              maxLength={VARIATION_CLAIM_LIMITS.maxScope}
              placeholder="e.g. Extra 3 double GPOs in garage"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Value ($, optional)</span>
            <input
              value={valueDollars}
              onChange={(e) => setValueDollars(e.target.value)}
              inputMode="decimal"
              placeholder="1250.00"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        {valueError && (
          <p className="text-xs text-red-700" role="alert">
            {valueError}
          </p>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={VARIATION_CLAIM_LIMITS.maxDescription}
            placeholder="What changed, who asked for it, labour and materials it needs…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !scope.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Raise claim
        </button>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium " +
              (filter === f ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")
            }
          >
            {f === "all"
              ? `All (${rollup.total})`
              : `${variationClaimStatusLabel(f)} (${rollup.counts[f]})`}
          </button>
        ))}
      </div>

      {/* List */}
      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">
          {filter === "all" ? "No variation claims yet." : "No claims in this view."}
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-900">
                  <span className="font-mono text-xs text-slate-500">{c.ref}</span> {c.scope}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums text-slate-900">
                    {formatClaimValue(c.valueCents)}
                  </span>
                  <span className={"rounded px-2 py-0.5 text-xs " + statusChipClass(c.status)}>
                    {variationClaimStatusLabel(c.status)}
                  </span>
                </div>
              </div>
              {c.description ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{c.description}</p>
              ) : null}
              <div className="mt-1 text-xs text-slate-500">
                {c.createdByName ? `Raised by ${c.createdByName}` : "Raised"}
                {c.createdAt ? ` · ${c.createdAt.slice(0, 10)}` : ""}
                {c.links?.observationId ? (
                  <>
                    {" · from site: "}
                    <Link
                      href={`/v2/jobs/${encodeURIComponent(jobId)}/observations` as Route}
                      className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                    >
                      observation {c.links.observationId}
                    </Link>
                  </>
                ) : null}
              </div>

              {/* Decision trail — only real recorded facts, never placeholders. */}
              {c.status === "approved" && c.approval ? (
                <p className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-900">
                  <span className="font-medium">Approved</span> by {c.approval.approvedBy} ·{" "}
                  {variationApprovalMethodLabel(c.approval.method)} ·{" "}
                  {c.approval.approvedAt.slice(0, 10)} · ref: {c.approval.reference}
                </p>
              ) : null}
              {c.status === "invoiced" ? (
                <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-700">
                  <span className="font-medium">Invoiced</span>
                  {c.invoiceRef ? ` — ${c.invoiceRef}` : ""}
                  {c.invoicedAt ? ` · ${c.invoicedAt.slice(0, 10)}` : ""}
                  {c.approval
                    ? ` · approved by ${c.approval.approvedBy} (${variationApprovalMethodLabel(c.approval.method)})`
                    : ""}
                </p>
              ) : null}
              {c.status === "rejected" && c.decisionNote ? (
                <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
                  <span className="font-medium">Rejected:</span> {c.decisionNote}
                </p>
              ) : null}

              {/* Actions — driven by the domain transition table. */}
              <div className="mt-3 flex flex-wrap gap-2">
                {canTransitionClaimStatus(c.status, "quoted") ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => run(async () => void (await quoteVariationClaim(jobId, c.id)))}
                  >
                    Mark quoted
                  </ActionButton>
                ) : null}
                {canTransitionClaimStatus(c.status, "submitted") ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => run(async () => void (await submitVariationClaim(jobId, c.id)))}
                  >
                    Submit to builder
                  </ActionButton>
                ) : null}
                {canTransitionClaimStatus(c.status, "approved") ? (
                  <ActionButton busy={busy} onClick={() => setApproving(c)}>
                    Record approval…
                  </ActionButton>
                ) : null}
                {canTransitionClaimStatus(c.status, "rejected") ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => {
                      setPanel({ id: c.id, kind: "reject" });
                      setDraft("");
                    }}
                  >
                    Record rejection…
                  </ActionButton>
                ) : null}
                {canTransitionClaimStatus(c.status, "invoiced") ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => {
                      setPanel({ id: c.id, kind: "invoice" });
                      setDraft("");
                    }}
                  >
                    Mark invoiced…
                  </ActionButton>
                ) : null}
                {c.status === "draft" ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => {
                      setPanel({ id: c.id, kind: "price" });
                      setDraft(c.valueCents != null ? (c.valueCents / 100).toFixed(2) : "");
                    }}
                  >
                    Set value…
                  </ActionButton>
                ) : null}
                {canTransitionClaimStatus(c.status, "draft") ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => run(async () => void (await reviseVariationClaim(jobId, c.id)))}
                  >
                    Back to draft
                  </ActionButton>
                ) : null}
              </div>

              {panel && panel.id === c.id ? (
                <InlinePanel
                  kind={panel.kind}
                  busy={busy}
                  draft={draft}
                  onDraftChange={setDraft}
                  onCancel={() => setPanel(null)}
                  onSave={() =>
                    run(async () => {
                      if (panel.kind === "reject") {
                        await rejectVariationClaim(jobId, c.id, {
                          note: draft.trim() || undefined,
                        });
                      } else if (panel.kind === "invoice") {
                        await invoiceVariationClaim(jobId, c.id, draft.trim());
                      } else {
                        const cents = draft.trim() ? dollarsToCents(draft) : null;
                        if (draft.trim() && cents == null) {
                          throw new Error("Enter a dollar value like 1250 or 1250.50.");
                        }
                        await updateVariationClaim(jobId, c.id, { valueCents: cents });
                      }
                      setPanel(null);
                      setDraft("");
                    })
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {approving ? (
        <ApprovalModal
          claim={approving}
          busy={busy}
          onCancel={() => setApproving(null)}
          onSave={(evidence) =>
            run(async () => {
              await approveVariationClaim(jobId, approving.id, evidence);
              setApproving(null);
            })
          }
        />
      ) : null}
    </div>
  );
}

function SummaryTile({ label, cents, count }: { label: string; cents: number; count: number }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <dt className="text-xs text-slate-500">
        {label} ({count})
      </dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums text-slate-900">
        {formatClaimValue(cents)}
      </dd>
    </div>
  );
}

function statusChipClass(status: VariationClaimStatus): string {
  switch (status) {
    case "approved":
      return "bg-emerald-100 text-emerald-900";
    case "invoiced":
      return "bg-slate-900 text-white";
    case "rejected":
      return "bg-amber-100 text-amber-900";
    case "submitted":
      return "bg-blue-100 text-blue-900";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Inline reject-note / invoice-ref / price panel. Invoice REQUIRES the manual
 *  reference (mirrors the server's invoiceRef gate); reject note is optional. */
function InlinePanel({
  kind,
  busy,
  draft,
  onDraftChange,
  onCancel,
  onSave,
}: {
  kind: PanelKind;
  busy: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const placeholder =
    kind === "reject"
      ? "Why the builder said no (optional, kept on the record)…"
      : kind === "invoice"
        ? "Invoice reference, e.g. INV-0042 (required — the invoice itself lives in Xero)"
        : "Value in dollars, e.g. 1250.50 — leave blank if no longer priced";
  const saveLabel =
    kind === "reject" ? "Save rejection" : kind === "invoice" ? "Mark invoiced" : "Save value";
  const saveDisabled = busy || (kind === "invoice" && !draft.trim());
  return (
    <div className="mt-2 space-y-2">
      {kind === "reject" ? (
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          rows={2}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          inputMode={kind === "price" ? "decimal" : undefined}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saveLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-slate-600"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * THE approval gate, client-side. All four evidence fields are required before
 * Save enables (the same isApprovalEvidenceComplete the server mirrors) — but
 * the server's 400 remains the authority if anything slips through.
 * (Exported for the render test — not part of the register's public surface.)
 */
export function ApprovalModal({
  claim,
  busy,
  onCancel,
  onSave,
}: {
  claim: VariationClaimRecord;
  busy: boolean;
  onCancel: () => void;
  onSave: (evidence: {
    approvedBy: string;
    approvedAt: string;
    method: VariationApprovalMethod;
    reference: string;
  }) => void;
}) {
  const [approvedBy, setApprovedBy] = useState("");
  const [approvedAt, setApprovedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<VariationApprovalMethod | "">("");
  const [reference, setReference] = useState("");

  const evidence =
    method === ""
      ? null
      : {
          approvedBy: approvedBy.trim(),
          approvedAt: approvedAt.trim(),
          method,
          reference: reference.trim(),
        };
  const complete = isApprovalEvidenceComplete(evidence);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Record approval for ${claim.ref}`}
    >
      <div className="w-full max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Record approval — {claim.ref}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            A claim can&rsquo;t become approved without the evidence a dispute would need: who said
            yes, when, how, and where that&rsquo;s recorded.
          </p>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Approved by</span>
          <input
            value={approvedBy}
            onChange={(e) => setApprovedBy(e.target.value)}
            placeholder="e.g. Steve M (site manager)"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Approved on</span>
            <input
              type="date"
              value={approvedAt}
              onChange={(e) => setApprovedAt(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">How</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as VariationApprovalMethod | "")}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Choose…</option>
              {VARIATION_APPROVAL_METHODS.map((m) => (
                <option key={m} value={m}>
                  {variationApprovalMethodLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Reference</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Email subject, call note, portal id or attachment link"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !complete}
            onClick={() => evidence && onSave(evidence)}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Approve claim
          </button>
        </div>
      </div>
    </div>
  );
}
