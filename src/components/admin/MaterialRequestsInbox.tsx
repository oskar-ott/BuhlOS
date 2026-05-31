"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  CheckCircle2,
  Package,
  PackageOpen,
  Truck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusChip } from "@/components/ui/StatusChip";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { relativeWhen } from "@/domains/jobs/format";
import { materialRequestsClient } from "@/domains/material-requests/client";
import {
  compareForInbox,
  isOpenRequest,
  summariseInbox,
} from "@/domains/material-requests/service";
import {
  formatQuantity,
  statusLabel,
  statusTone,
  urgencyLabel,
  urgencyTone,
} from "@/domains/material-requests/format";
import {
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_URGENCIES,
} from "@/domains/material-requests/schema";
import type {
  MaterialRequestItem,
  MaterialRequestStatus,
  MaterialRequestUrgency,
  UpdateMaterialRequestPayload,
} from "@/domains/material-requests/types";

interface Props {
  initialRequests: ReadonlyArray<MaterialRequestItem>;
  fetchError: string | null;
  /** PR 11: when false (per-job LH read-only view), hide action sections. */
  actionsEnabled?: boolean;
  /** PR 11: hide job filter when scoped to one job. */
  showJobFilter?: boolean;
}

interface Filters {
  status: MaterialRequestStatus | "";
  urgency: MaterialRequestUrgency | "";
  jobId: string;
}
const EMPTY_FILTERS: Filters = { status: "", urgency: "", jobId: "" };

/**
 * BuhlOS Materials Request Inbox (PR 11). Procurement-side cousin of the
 * observations inbox: same exception-first sort, same drawer-with-actions
 * UX, different lifecycle (requested → approved → ordered → delivered, with
 * a cancel exit at any time).
 *
 * Mirrors ObservationsInbox.tsx structure for consistency.
 */
export function MaterialRequestsInbox({
  initialRequests,
  fetchError,
  actionsEnabled = true,
  showJobFilter = true,
}: Props) {
  // viewer intentionally not on Props: v1 procurement actions don't branch on
  // the viewer client-side — the API stamps the actor from the session cookie.
  // ObservationsInbox carries `viewer` because of "Assign to me"; this inbox
  // has no per-viewer affordances yet.
  const [requests, setRequests] = useState<ReadonlyArray<MaterialRequestItem>>(initialRequests);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const [supplierDraft, setSupplierDraft] = useState("");
  const [orderRefDraft, setOrderRefDraft] = useState("");
  const [supplierNoteDraft, setSupplierNoteDraft] = useState("");
  const [cancelReasonDraft, setCancelReasonDraft] = useState("");
  const [deliveryNoteDraft, setDeliveryNoteDraft] = useState("");

  const summary = useMemo(() => summariseInbox(requests), [requests]);

  const jobOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of requests) {
      if (!map.has(r.jobId)) map.set(r.jobId, r.jobName || r.jobId);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [requests]);

  const visible = useMemo(() => {
    const matched = requests.filter((r) => {
      if (filters.status && r.status !== filters.status) return false;
      if (filters.urgency && r.urgency !== filters.urgency) return false;
      if (filters.jobId && r.jobId !== filters.jobId) return false;
      return true;
    });
    return matched.slice().sort(compareForInbox);
  }, [requests, filters]);

  const selected = useMemo(
    () => requests.find((r) => r.id === selectedId) ?? null,
    [requests, selectedId]
  );

  const filtersActive = Object.values(filters).some((v) => v !== "");

  function resetDrafts(r: MaterialRequestItem | null) {
    setSupplierDraft(r?.supplier ?? "");
    setOrderRefDraft(r?.orderRef ?? "");
    setSupplierNoteDraft(r?.supplierNote ?? "");
    setDeliveryNoteDraft(r?.deliveryNote ?? "");
    setCancelReasonDraft("");
  }

  async function apply(id: string, patch: Omit<UpdateMaterialRequestPayload, "id">) {
    setBusy(true);
    setBanner(null);
    const r = await materialRequestsClient.updateMaterialRequest({ id, ...patch });
    setBusy(false);
    if (!r.ok) {
      setBanner({
        tone: "danger",
        message:
          r.error.status === 0
            ? "Couldn't reach the server. Check your connection and try again."
            : r.error.status === 409
              ? "That status change isn't allowed from the current state."
              : `Update failed (${r.error.status}).`,
      });
      return;
    }
    const updated = r.data.request;
    setRequests((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setBanner({ tone: "success", message: "Updated." });
    resetDrafts(updated);
  }

  return (
    <div className="space-y-5">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load material requests</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. The list may be incomplete.
          </CardDescription>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      {banner ? (
        <div
          role="status"
          className={
            banner.tone === "success"
              ? "rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
              : "rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          }
        >
          {banner.message}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="To approve / order" value={summary.requested + summary.approved} icon={PackageOpen} tone="warning" />
        <SummaryCard label="On order" value={summary.ordered} icon={Truck} tone="info" />
        <SummaryCard label="Delivered" value={summary.delivered} icon={CheckCircle2} tone="success" />
        <SummaryCard label="Urgent / high (open)" value={summary.urgentOpen} icon={Package} tone="danger" />
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3">
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v as MaterialRequestStatus | "" }))}
          options={MATERIAL_REQUEST_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        />
        <FilterSelect
          label="Urgency"
          value={filters.urgency}
          onChange={(v) => setFilters((f) => ({ ...f, urgency: v as MaterialRequestUrgency | "" }))}
          options={MATERIAL_REQUEST_URGENCIES.map((u) => ({ value: u, label: urgencyLabel(u) }))}
        />
        {showJobFilter ? (
          <FilterSelect
            label="Job"
            value={filters.jobId}
            onChange={(v) => setFilters((f) => ({ ...f, jobId: v }))}
            options={jobOptions.map((j) => ({ value: j.id, label: j.name }))}
          />
        ) : null}
        {filtersActive ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear
          </Button>
        ) : null}
        <span className="ml-auto self-center text-xs text-text-muted">
          {visible.length} of {requests.length}
        </span>
      </div>

      {requests.length === 0 && !fetchError ? (
        <EmptyState
          title="No material requests yet"
          description="Field workers raise material needs as observations in Phil. The office converts those to tracked material requests here, then approves / orders / receives them. Anything created directly from BuhlOS also lands here."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing matches these filters"
          description="Try clearing a filter to see more."
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => (
            <li key={r.id}>
              <Row
                request={r}
                onOpen={() => {
                  setSelectedId(r.id);
                  resetDrafts(r);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <DetailDrawer
        request={selected}
        busy={busy}
        actionsEnabled={actionsEnabled}
        supplierDraft={supplierDraft}
        orderRefDraft={orderRefDraft}
        supplierNoteDraft={supplierNoteDraft}
        cancelReasonDraft={cancelReasonDraft}
        deliveryNoteDraft={deliveryNoteDraft}
        onSupplierChange={setSupplierDraft}
        onOrderRefChange={setOrderRefDraft}
        onSupplierNoteChange={setSupplierNoteDraft}
        onCancelReasonChange={setCancelReasonDraft}
        onDeliveryNoteChange={setDeliveryNoteDraft}
        onClose={() => {
          setSelectedId(null);
          resetDrafts(null);
        }}
        onApply={apply}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Package;
  tone: "warning" | "danger" | "success" | "info";
}) {
  const toneClass =
    value === 0
      ? "text-text-muted"
      : tone === "danger"
        ? "text-rose-700"
        : tone === "warning"
          ? "text-amber-700"
          : tone === "info"
            ? "text-sky-700"
            : "text-emerald-700";
  return (
    <Card className="flex items-center justify-between gap-2">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
        <p className={`mt-1 font-display text-2xl ${toneClass}`}>{value}</p>
      </div>
      <Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${toneClass}`} />
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      <span className="uppercase tracking-wider">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[8rem] rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row({
  request: r,
  onOpen,
}: {
  request: MaterialRequestItem;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-card border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-subtle"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={statusTone(r.status)}>{statusLabel(r.status)}</StatusChip>
        {r.urgency !== "normal" && r.urgency !== "low" ? (
          <StatusChip tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</StatusChip>
        ) : null}
        <span className="font-mono text-xs text-text-muted">
          {formatQuantity(r.quantity, r.unit)}
        </span>
      </div>
      <p className="font-display text-sm font-semibold text-text">{r.item}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
        <span className="font-medium text-text">{r.jobName || r.jobId}</span>
        {r.supplier ? (
          <>
            <span aria-hidden="true">·</span>
            <span>Supplier: {r.supplier}</span>
          </>
        ) : null}
        {r.orderRef ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono">PO {r.orderRef}</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <span>{r.requestedByName}</span>
        <span aria-hidden="true">·</span>
        <span>{relativeWhen(r.requestedAt)}</span>
      </p>
    </button>
  );
}

function DetailDrawer({
  request: r,
  busy,
  actionsEnabled,
  supplierDraft,
  orderRefDraft,
  supplierNoteDraft,
  cancelReasonDraft,
  deliveryNoteDraft,
  onSupplierChange,
  onOrderRefChange,
  onSupplierNoteChange,
  onCancelReasonChange,
  onDeliveryNoteChange,
  onClose,
  onApply,
}: {
  request: MaterialRequestItem | null;
  busy: boolean;
  actionsEnabled: boolean;
  supplierDraft: string;
  orderRefDraft: string;
  supplierNoteDraft: string;
  cancelReasonDraft: string;
  deliveryNoteDraft: string;
  onSupplierChange: (v: string) => void;
  onOrderRefChange: (v: string) => void;
  onSupplierNoteChange: (v: string) => void;
  onCancelReasonChange: (v: string) => void;
  onDeliveryNoteChange: (v: string) => void;
  onClose: () => void;
  onApply: (id: string, patch: Omit<UpdateMaterialRequestPayload, "id">) => void;
}) {
  if (!r) return null;
  const isOpen = isOpenRequest(r.status);
  return (
    <Drawer
      open={!!r}
      onClose={onClose}
      title={r.item}
      subtitle={`${formatQuantity(r.quantity, r.unit)} · ${r.jobName || r.jobId}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            {busy ? "Saving…" : `Requested ${relativeWhen(r.requestedAt)}`}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={statusTone(r.status)}>{statusLabel(r.status)}</StatusChip>
          <StatusChip tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</StatusChip>
        </div>

        {r.description ? (
          <p className="whitespace-pre-wrap text-sm text-text">{r.description}</p>
        ) : (
          <p className="text-sm italic text-text-muted">No description.</p>
        )}

        <dl className="space-y-1.5 text-sm">
          <DetailRow label="Job" value={r.jobName || r.jobId} />
          {r.areaName ? <DetailRow label="Area" value={r.areaName} /> : null}
          {r.stage ? (
            <DetailRow label="Stage" value={r.stage === "roughIn" ? "Rough-in" : "Fit-off"} />
          ) : null}
          {r.taskName ? <DetailRow label="Task" value={r.taskName} /> : null}
          <DetailRow
            label="Requested by"
            value={`${r.requestedByName}${r.requestedByRole ? ` (${r.requestedByRole})` : ""}`}
          />
          {r.linkedObservationId ? (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-text-muted">From observation</dt>
              <dd className="min-w-0 flex-1 text-text">
                <Link
                  href={"/observations" as Route}
                  className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  {r.linkedObservationId} →
                </Link>
              </dd>
            </div>
          ) : null}
          {r.supplier ? <DetailRow label="Supplier" value={r.supplier} /> : null}
          {r.orderRef ? <DetailRow label="PO / order ref" value={r.orderRef} /> : null}
          {r.supplierNote ? <DetailRow label="Supplier note" value={r.supplierNote} /> : null}
          {r.deliveredAt ? (
            <DetailRow
              label="Delivered"
              value={`${relativeWhen(r.deliveredAt)}${r.deliveredByName ? ` · ${r.deliveredByName}` : ""}`}
            />
          ) : null}
          {r.deliveryNote ? <DetailRow label="Delivery note" value={r.deliveryNote} /> : null}
          {r.cancelReason ? <DetailRow label="Cancel reason" value={r.cancelReason} /> : null}
        </dl>

        {!actionsEnabled ? (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
            Read-only view. Approve / order / mark-delivered live on the cross-job
            {" "}
            <Link
              href={"/material-requests" as Route}
              className="underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              Material requests inbox
            </Link>
            {" "}(admin-only).
          </p>
        ) : (
          <>
            {/* Status actions — only show transitions that are legal from the
                current state, with required-field inputs inline (supplier +
                orderRef for ordered, cancelReason for cancelled). */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Procurement
              </h3>

              {/* Approve (requested → approved) */}
              {r.status === "requested" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => onApply(r.id, { status: "approved" })}
                >
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                  Approve
                </Button>
              ) : null}

              {/* Order (requested/approved → ordered) — supplier + PO inline */}
              {r.status === "requested" || r.status === "approved" ? (
                <div className="space-y-2 rounded-card border border-border bg-surface-subtle p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Mark ordered
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs text-text-muted">
                      Supplier
                      <input
                        type="text"
                        value={supplierDraft}
                        onChange={(e) => onSupplierChange(e.target.value)}
                        placeholder="e.g. CMI Cabling"
                        className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
                      />
                    </label>
                    <label className="block text-xs text-text-muted">
                      PO / order ref
                      <input
                        type="text"
                        value={orderRefDraft}
                        onChange={(e) => onOrderRefChange(e.target.value)}
                        placeholder="e.g. PO-4521"
                        className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text font-mono"
                      />
                    </label>
                  </div>
                  <label className="block text-xs text-text-muted">
                    Supplier note (optional)
                    <textarea
                      value={supplierNoteDraft}
                      onChange={(e) => onSupplierNoteChange(e.target.value)}
                      rows={2}
                      placeholder="ETA, freight cost, alternatives…"
                      className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      onApply(r.id, {
                        status: "ordered",
                        supplier: supplierDraft || null,
                        orderRef: orderRefDraft || null,
                        supplierNote: supplierNoteDraft || null,
                      })
                    }
                  >
                    <Truck aria-hidden="true" className="h-4 w-4" />
                    Mark ordered
                  </Button>
                </div>
              ) : null}

              {/* Mark delivered (ordered → delivered) */}
              {r.status === "ordered" ? (
                <div className="space-y-2 rounded-card border border-border bg-surface-subtle p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    Mark delivered
                  </p>
                  <label className="block text-xs text-text-muted">
                    Delivery note (optional)
                    <textarea
                      value={deliveryNoteDraft}
                      onChange={(e) => onDeliveryNoteChange(e.target.value)}
                      rows={2}
                      placeholder="Qty received, condition, alternatives…"
                      className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      onApply(r.id, {
                        status: "delivered",
                        deliveryNote: deliveryNoteDraft || null,
                      })
                    }
                  >
                    <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                    Mark delivered
                  </Button>
                </div>
              ) : null}
            </section>

            {/* Urgency — always available while open */}
            {isOpen ? (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Urgency
                </h3>
                <div className="flex flex-wrap gap-2">
                  {MATERIAL_REQUEST_URGENCIES.map((u) => (
                    <Button
                      key={u}
                      type="button"
                      size="sm"
                      variant={r.urgency === u ? "primary" : "secondary"}
                      disabled={busy || r.urgency === u}
                      onClick={() => onApply(r.id, { urgency: u })}
                    >
                      {urgencyLabel(u)}
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Cancel — available while open */}
            {isOpen ? (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Cancel
                </h3>
                <label className="block text-xs text-text-muted">
                  Why cancelled (required)
                  <input
                    type="text"
                    value={cancelReasonDraft}
                    onChange={(e) => onCancelReasonChange(e.target.value)}
                    placeholder="duplicate / not needed / wrong job…"
                    className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={busy || !cancelReasonDraft.trim()}
                  onClick={() =>
                    onApply(r.id, {
                      status: "cancelled",
                      cancelReason: cancelReasonDraft.trim(),
                    })
                  }
                >
                  <XCircle aria-hidden="true" className="h-4 w-4" />
                  Cancel request
                </Button>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-text">{value}</dd>
    </div>
  );
}
