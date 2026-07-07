"use client";

import { useState } from "react";
import { ReceiptText } from "lucide-react";
import { SubmitExpenseSheet } from "./SubmitExpenseSheet";
import { PhilNotice } from "./ui/PhilNotice";
import { EXPENSE_CATEGORY_LABELS, EXPENSE_OPTION } from "@/domains/expenses/service";
import { formatAud } from "@/domains/expenses/schema";
import type { ExpenseItem } from "@/domains/expenses/types";

/**
 * Phil — "Submit a receipt" entry point on My Day (#536).
 *
 * Self-contained: it owns the sheet open/close AND the result banner, so the
 * success/error message survives the sheet auto-closing on submit (the
 * BUG-C-003 lesson — never put the outcome UI inside a sheet that closes).
 * One tap → SubmitExpenseSheet → a confirmation the worker can see.
 */
export function PhilExpenseEntry({
  headerClassName = "mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted",
}: {
  /** Section-heading classes. Default = today's header, byte-identical; the
   *  sharpened My Day passes its own section-label style. */
  headerClassName?: string;
} = {}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<
    { kind: "ok"; item: ExpenseItem } | { kind: "error"; message: string } | null
  >(null);

  return (
    <section aria-labelledby="phil-expense-entry">
      <h2 id="phil-expense-entry" className={headerClassName}>
        Reimbursements
      </h2>

      {result?.kind === "ok" ? (
        <PhilNotice tone="success" role="status" title="Receipt submitted">
          <p>
            {formatAud(result.item.amountCents)} · {EXPENSE_CATEGORY_LABELS[result.item.category]}.
            The office will review it.
          </p>
        </PhilNotice>
      ) : result?.kind === "error" ? (
        <PhilNotice tone="danger" role="alert" title="Couldn’t submit">
          <p>{result.message}</p>
        </PhilNotice>
      ) : null}

      <button
        type="button"
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
        className="mt-2 flex min-h-[84px] w-full flex-col gap-1.5 rounded-card border border-border bg-surface-raised p-3 text-left shadow-card transition-colors active:bg-surface-subtle"
      >
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-yellow text-brand-navy">
          <ReceiptText className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold leading-tight text-text">{EXPENSE_OPTION.label}</span>
        <span className="text-xs leading-tight text-text-muted">{EXPENSE_OPTION.hint}</span>
      </button>

      <SubmitExpenseSheet
        open={open}
        onClose={() => setOpen(false)}
        onSubmitted={(item) => setResult({ kind: "ok", item })}
        onFailed={(message) => setResult({ kind: "error", message })}
      />
    </section>
  );
}
