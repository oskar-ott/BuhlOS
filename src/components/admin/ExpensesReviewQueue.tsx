"use client";

import { useMemo, useState } from "react";
import { Paperclip } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { ExpenseDetailDrawer } from "./ExpenseDetailDrawer";
import { ExpenseDeclineModal } from "./ExpenseDeclineModal";
import { transitionExpense } from "@/domains/expenses/client";
import {
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_STATUS_LABELS,
  sortForReview,
  summariseExpenses,
} from "@/domains/expenses/service";
import { formatAud, nextStatuses } from "@/domains/expenses/schema";
import type { ExpenseItem, ExpenseStatus } from "@/domains/expenses/types";

interface Props {
  initialExpenses: ReadonlyArray<ExpenseItem>;
  fetchError: string | null;
}

const STATUS_TONE: Record<ExpenseStatus, "neutral" | "warning" | "success" | "danger"> = {
  submitted: "warning",
  approved: "neutral",
  reimbursed: "success",
  rejected: "danger",
};

const ACTION_LABEL: Record<ExpenseStatus, string> = {
  approved: "Approve",
  reimbursed: "Mark reimbursed",
  rejected: "Decline",
  submitted: "Reopen",
};

type Filter = "all" | ExpenseStatus;
const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "submitted", label: "Awaiting review" },
  { key: "approved", label: "Approved" },
  { key: "reimbursed", label: "Reimbursed" },
  { key: "rejected", label: "Declined" },
];

/**
 * Office reimbursement queue (#536) — review field-submitted receipts and move
 * each through submitted → approved → reimbursed (or declined). The PATCH is
 * admin-gated server-side; this surfaces the worker's exact entry (amount,
 * category, receipt photo) with no fabricated totals (P7). Payout itself runs
 * through payroll/Xero (#249), out of scope here.
 */
export function ExpensesReviewQueue({ initialExpenses, fetchError }: Props) {
  const [expenses, setExpenses] = useState<ExpenseItem[]>([...initialExpenses]);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The receipt+summary detail drawer + the required-reason decline modal.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [declineTarget, setDeclineTarget] = useState<ExpenseItem | null>(null);

  const summary = useMemo(() => summariseExpenses(expenses), [expenses]);
  const rows = useMemo(() => {
    const filtered = filter === "all" ? expenses : expenses.filter((e) => e.status === filter);
    return sortForReview(filtered);
  }, [expenses, filter]);
  // The drawer reads the LIVE item so a transition (from the row or the drawer)
  // is reflected without a refetch.
  const selected = selectedId ? (expenses.find((e) => e.id === selectedId) ?? null) : null;

  // One transition path for the row AND the drawer. Decline carries a required
  // reason (from the modal); other moves take the optional inline note.
  async function act(item: ExpenseItem, to: ExpenseStatus, reviewNoteOverride?: string) {
    setBusyId(item.id);
    setRowError((m) => ({ ...m, [item.id]: "" }));
    const reviewNote = reviewNoteOverride ?? (notes[item.id]?.trim() || undefined);
    const r = await transitionExpense({ id: item.id, status: to, reviewNote });
    setBusyId(null);
    if (r.ok) {
      setExpenses((prev) => prev.map((e) => (e.id === item.id ? r.data.expense : e)));
      setNotes((m) => ({ ...m, [item.id]: "" }));
    } else {
      setRowError((m) => ({ ...m, [item.id]: r.error.message || "Couldn't update — try again." }));
    }
  }

  // Decline always opens the required-reason modal (row + drawer both route
  // 'rejected' here); every other transition goes straight through act().
  function onAction(item: ExpenseItem, to: ExpenseStatus) {
    if (to === "rejected") {
      setDeclineTarget(item);
    } else {
      void act(item, to);
    }
  }

  async function submitDecline(reason: string) {
    const target = declineTarget;
    if (!target) return;
    await act(target, "rejected", reason);
    setDeclineTarget(null);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>To reimburse</CardTitle>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Awaiting review" value={String(summary.pendingCount)} />
          <Metric label="Awaiting total" value={formatAud(summary.pendingTotalCents)} />
          <Metric label="Approved, unpaid" value={String(summary.approvedUnpaidCount)} />
          <Metric label="Unpaid total" value={formatAud(summary.approvedUnpaidTotalCents)} />
        </div>
        <CardDescription className="mt-3">
          BuhlOS captures + approves; payout runs through payroll/Xero (no direct connection yet).
        </CardDescription>
      </Card>

      {fetchError ? (
        <Card>
          <CardTitle>Couldn&rsquo;t load expenses</CardTitle>
          <CardDescription className="mt-1">{fetchError}. Reload to try again.</CardDescription>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={
                  filter === f.key
                    ? "rounded-card border border-brand-navy bg-brand-navy px-3 py-1.5 text-xs font-semibold text-text-inverse"
                    : "rounded-card border border-border px-3 py-1.5 text-xs font-medium text-text hover:border-brand-navy"
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <Card>
              <CardDescription>No expenses{filter === "all" ? " yet" : " in this view"}.</CardDescription>
            </Card>
          ) : (
            <ul className="space-y-3">
              {rows.map((e) => {
                const actions = nextStatuses(e.status);
                const busy = busyId === e.id;
                return (
                  <li key={e.id}>
                    <Card>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-semibold tabular-nums text-text">
                              {formatAud(e.amountCents)}
                            </span>
                            <Pill tone={STATUS_TONE[e.status]}>{EXPENSE_STATUS_LABELS[e.status]}</Pill>
                          </div>
                          <div className="mt-0.5 text-sm text-text-muted">
                            {EXPENSE_CATEGORY_LABELS[e.category]} · {e.submittedByName}
                            {e.jobName ? ` · ${e.jobName}` : ""} ·{" "}
                            {new Date(e.createdAt).toLocaleDateString("en-AU", {
                              day: "numeric",
                              month: "short",
                            })}
                          </div>
                          {e.note ? <p className="mt-1 text-sm text-text">{e.note}</p> : null}
                          {e.reviewNote ? (
                            <p className="mt-1 text-xs text-text-muted">Review note: {e.reviewNote}</p>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setSelectedId(e.id)}
                            className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-state-info"
                          >
                            <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
                            View receipt &amp; summary
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedId(e.id)}
                          className="shrink-0"
                          aria-label="View receipt & summary"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={e.receiptPhotoUrl}
                            alt="Receipt"
                            className="h-16 w-16 rounded-card border border-border object-cover"
                            loading="lazy"
                          />
                        </button>
                      </div>

                      {actions.length > 0 ? (
                        <div className="mt-3 space-y-2 border-t border-border pt-3">
                          <input
                            type="text"
                            value={notes[e.id] ?? ""}
                            onChange={(ev) => setNotes((m) => ({ ...m, [e.id]: ev.target.value }))}
                            placeholder="Reason / note (optional)"
                            className="h-9 w-full rounded-card border border-border bg-surface px-3 text-sm text-text outline-none focus:border-brand-navy"
                          />
                          <div className="flex flex-wrap gap-2">
                            {actions.map((to) => (
                              <Button
                                key={to}
                                size="sm"
                                variant={to === "rejected" ? "secondary" : "primary"}
                                disabled={busy}
                                onClick={() => onAction(e, to)}
                              >
                                {busy ? "Saving…" : ACTION_LABEL[to]}
                              </Button>
                            ))}
                          </div>
                          {rowError[e.id] ? (
                            <p className="text-xs text-state-danger" role="alert">
                              {rowError[e.id]}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* Receipt + summary detail (opens from a row); approve/decline route
          through the same act() as the row, so list, roll-up and drawer stay in
          sync. Decline always goes through the required-reason modal. */}
      <ExpenseDetailDrawer
        item={selected}
        open={selected !== null}
        busy={selected ? busyId === selected.id : false}
        onClose={() => setSelectedId(null)}
        onAction={onAction}
      />
      <ExpenseDeclineModal
        open={declineTarget !== null}
        item={declineTarget}
        busy={declineTarget ? busyId === declineTarget.id : false}
        onClose={() => setDeclineTarget(null)}
        onSubmit={(reason) => void submitDecline(reason)}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-surface-subtle px-3 py-2">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-text">{value}</div>
    </div>
  );
}
