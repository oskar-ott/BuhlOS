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
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";
import {
  InboxBanner,
  InboxFilterBar,
  InboxFilterSelect,
  InboxLoadErrorCard,
  InboxStatStrip,
  type InboxStat,
} from "./InboxShell";
import { relativeWhen } from "@/domains/jobs/format";
import { materialRequestsClient } from "@/domains/material-requests/client";
import {
  compareForInbox,
  isOpenRequest,
  summariseInbox,
  type MaterialRequestSummary,
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
  /** Deep-link: pre-seed the status filter (from `?status=`). Ignored if blank. */
  initialStatus?: MaterialRequestStatus | "";
  /** Deep-link: open this request's drawer on mount (from `?focus=`). */
  initialSelectedId?: string | null;
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
  initialStatus = "",
  initialSelectedId = null,
}: Props) {
  // viewer intentionally not on Props: v1 procurement actions don't branch on
  // the viewer client-side — the API stamps the actor from the session cookie.
  // ObservationsInbox carries `viewer` because of "Assign to me"; this inbox
  // has no per-viewer affordances yet.
  const [requests, setRequests] = useState<ReadonlyArray<MaterialRequestItem>>(initialRequests);
  // Deep-link seed (from `?status=`/`?focus=`): the status filter pre-applies and
  // the focused request's drawer opens. A `focus` id that isn't in the list just
  // leaves the drawer closed (see `selected` below) — safe, no error.
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, status: initialStatus });
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  // Seed the action drafts from the deep-linked (?focus=) request so a focused
  // requested/approved item's order form renders with its EXISTING supplier /
  // ref / notes. Without this, those inputs would be blank and "Mark ordered"
  // would PATCH them to null. Row clicks reset drafts via resetDrafts(); this
  // covers the initial drawer that opens without a click.
  const focusedRequest =
    initialSelectedId != null
      ? initialRequests.find((r) => r.id === initialSelectedId) ?? null
      : null;
  const [supplierDraft, setSupplierDraft] = useState(focusedRequest?.supplier ?? "");
  const [orderRefDraft, setOrderRefDraft] = useState(focusedRequest?.orderRef ?? "");
  const [supplierNoteDraft, setSupplierNoteDraft] = useState(focusedRequest?.supplierNote ?? "");
  const [cancelReasonDraft, setCancelReasonDraft] = useState("");
  const [deliveryNoteDraft, setDeliveryNoteDraft] = useState(focusedRequest?.deliveryNote ?? "");

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

  const stats: InboxStat[] = [
    { key: "approve", label: "To approve / order", value: summary.requested + summary.approved, icon: PackageOpen, tone: "warning" },
    { key: "ordered", label: "On order", value: summary.ordered, icon: Truck, tone: "info" },
    { key: "delivered", label: "Delivered", value: summary.delivered, icon: CheckCircle2, tone: "success" },
    { key: "urgent", label: "Urgent / high (open)", value: summary.urgentOpen, icon: Package, tone: "danger" },
  ];

  return (
    <div className="space-y-5">
      {fetchError ? (
        <InboxLoadErrorCard
          title="Couldn’t load material requests"
          message={`${fetchError}. The list may be incomplete.`}
        />
      ) : null}

      {banner ? <InboxBanner tone={banner.tone}>{banner.message}</InboxBanner> : null}

      {/* Procurement pipeline — the lifecycle a request moves through. Each
          stage is a real count off `summary` and filters the list to it; the
          stat strip below keeps the urgent / exception read. */}
      <MaterialPipeline
        summary={summary}
        activeStatus={filters.status}
        onPick={(status) =>
          setFilters((f) => ({ ...f, status: f.status === status ? "" : status }))
        }
      />

      <InboxStatStrip stats={stats} />

      <InboxFilterBar
        shown={visible.length}
        total={requests.length}
        onClear={filtersActive ? () => setFilters(EMPTY_FILTERS) : undefined}
      >
        <InboxFilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v as MaterialRequestStatus | "" }))}
          options={MATERIAL_REQUEST_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        />
        <InboxFilterSelect
          label="Urgency"
          value={filters.urgency}
          onChange={(v) => setFilters((f) => ({ ...f, urgency: v as MaterialRequestUrgency | "" }))}
          options={MATERIAL_REQUEST_URGENCIES.map((u) => ({ value: u, label: urgencyLabel(u) }))}
        />
        {showJobFilter ? (
          <InboxFilterSelect
            label="Job"
            value={filters.jobId}
            onChange={(v) => setFilters((f) => ({ ...f, jobId: v }))}
            options={jobOptions.map((j) => ({ value: j.id, label: j.name }))}
          />
        ) : null}
      </InboxFilterBar>

      {requests.length === 0 && !fetchError ? (
        <EmptyState
          title="No material requests yet"
          description="Field workers raise material needs as observations in the field app. The office converts those to tracked material requests here, then approves / orders / receives them. Anything created directly from BuhlOS also lands here."
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

/* ── Procurement pipeline ───────────────────────────────────────────────── */

const PIPELINE_STAGES: ReadonlyArray<{
  status: MaterialRequestStatus;
  label: string;
  icon: typeof PackageOpen;
}> = [
  { status: "requested", label: "Requested", icon: PackageOpen },
  { status: "approved", label: "Approved", icon: CheckCircle2 },
  { status: "ordered", label: "Ordered", icon: Truck },
  { status: "delivered", label: "Delivered", icon: Package },
];

/**
 * The four-stage procurement pipeline: Requested → Approved → Ordered →
 * Delivered, each a real count off `summary` (summariseInbox) and a button that
 * filters the list to that stage (toggles off when it's already active). The
 * connecting arrow reads left-to-right as the lifecycle. Cancelled is a
 * terminal exit, not a pipeline stage, so it isn't shown here (the status
 * filter still reaches it).
 */
function MaterialPipeline({
  summary,
  activeStatus,
  onPick,
}: {
  summary: MaterialRequestSummary;
  activeStatus: MaterialRequestStatus | "";
  onPick: (status: MaterialRequestStatus) => void;
}) {
  return (
    <div
      className="flex items-stretch gap-1 overflow-x-auto rounded-card border border-border bg-surface p-2"
      data-testid="material-pipeline"
    >
      {PIPELINE_STAGES.map((stage, i) => {
        const count = summary[stage.status];
        const active = activeStatus === stage.status;
        const Icon = stage.icon;
        return (
          <div key={stage.status} className="flex flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => onPick(stage.status)}
              aria-pressed={active}
              data-testid={`material-pipeline-${stage.status}`}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 rounded-card px-3 py-2 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
                active ? "bg-brand-navy text-text-inverse" : "hover:bg-surface-subtle"
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn("h-4 w-4", active ? "text-text-inverse" : "text-text-muted")}
              />
              <span
                className={cn(
                  "font-display text-xl tabular-nums",
                  active ? "text-text-inverse" : count === 0 ? "text-text-muted" : "text-text"
                )}
              >
                {count}
              </span>
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-wider",
                  active ? "text-text-inverse" : "text-text-muted"
                )}
              >
                {stage.label}
              </span>
            </button>
            {i < PIPELINE_STAGES.length - 1 ? (
              <span aria-hidden="true" className="shrink-0 px-0.5 text-text-muted">
                →
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
