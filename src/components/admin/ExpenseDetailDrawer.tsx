"use client";

import { ExternalLink, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Pill } from "@/components/ui/Pill";
import { EXPENSE_CATEGORY_LABELS, EXPENSE_STATUS_LABELS } from "@/domains/expenses/service";
import { formatAud, nextStatuses } from "@/domains/expenses/schema";
import type { ExpenseItem, ExpenseStatus } from "@/domains/expenses/types";

interface Props {
  item: ExpenseItem | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  /** Route a transition; the parent sends 'rejected' through the decline modal. */
  onAction: (item: ExpenseItem, to: ExpenseStatus) => void;
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

/**
 * Expense receipt + summary detail (#536). A claim is only as good as its
 * receipt, so this opens the full-size receipt photo before the office acts on
 * it, with the breakdown and status-appropriate approve / decline.
 *
 * Honesty (P7): GST and "Paid by" do NOT exist on the expense record yet — they
 * are shown as explicit "not captured / UC" cells, never invented. ("Category"
 * is the spend category, not a tax classification.) Follow-up: capture a GST
 * split + payment method at submit time in Phil.
 */
export function ExpenseDetailDrawer({ item, open, busy, onClose, onAction }: Props) {
  const actions = item ? nextStatuses(item.status) : [];
  return (
    <Drawer
      open={open && item !== null}
      onClose={onClose}
      title={item ? formatAud(item.amountCents) : "Expense"}
      subtitle={item ? EXPENSE_CATEGORY_LABELS[item.category] : undefined}
      footer={
        item && actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((to) => (
              <Button
                key={to}
                variant={to === "rejected" ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => onAction(item, to)}
                className="min-h-[44px] flex-1"
              >
                {busy
                  ? "Saving…"
                  : to === "approved"
                    ? `Approve ${formatAud(item.amountCents)}`
                    : ACTION_LABEL[to]}
              </Button>
            ))}
          </div>
        ) : null
      }
    >
      {item ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <Pill tone={STATUS_TONE[item.status]}>{EXPENSE_STATUS_LABELS[item.status]}</Pill>
            <span className="font-mono text-xs text-text-muted">
              {new Date(item.createdAt).toLocaleDateString("en-AU", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          </div>

          {/* Receipt — the full-size photo (in-app), plus an open-original link. */}
          <div className="overflow-hidden rounded-card border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element -- receipt blob URL, not a next/image asset */}
            <img
              src={item.receiptPhotoUrl}
              alt="Receipt"
              className="block max-h-[60vh] w-full object-contain bg-surface-subtle"
            />
            <a
              href={item.receiptPhotoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-text-muted hover:text-text"
            >
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              Receipt on file
              <ExternalLink aria-hidden="true" className="ml-auto h-3.5 w-3.5" />
            </a>
          </div>

          {/* Summary */}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Amount">
              <span className="font-semibold tabular-nums">{formatAud(item.amountCents)}</span>
            </Field>
            <Field label="GST incl.">
              <Uc />
            </Field>
            <Field label="Submitted by">
              {item.submittedByName}
              <span className="block text-xs text-text-muted">{item.submittedByRole}</span>
            </Field>
            <Field label="Category">{EXPENSE_CATEGORY_LABELS[item.category]}</Field>
            <Field label="Job">{item.jobName ?? "No job"}</Field>
            <Field label="Paid by">
              <Uc />
            </Field>
          </dl>

          {item.note ? (
            <div className="rounded-card bg-surface-subtle p-3 text-sm text-text">{item.note}</div>
          ) : null}
          {item.reviewNote ? (
            <p className="text-xs text-text-muted">Review note: {item.reviewNote}</p>
          ) : null}

          <p className="font-mono text-[10.5px] tracking-wide text-text-muted">
            Reimbursed through payroll · the full audit trail runs in BuhlOS on desktop.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-text">{children}</dd>
    </div>
  );
}

/** Honest "not captured" marker for a field the record doesn't carry yet. */
function Uc() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Pill tone="neutral">UC</Pill>
      <span className="text-xs text-text-muted">not captured</span>
    </span>
  );
}
