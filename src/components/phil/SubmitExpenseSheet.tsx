"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ReceiptText, X, Camera } from "lucide-react";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { resizeImageToDataUrl } from "@/domains/evidence/service";
import { submitExpense, uploadReceiptPhoto } from "@/domains/expenses/client";
import {
  EXPENSE_AMOUNT_MAX_CENTS,
  centsFromDollarInput,
  formatAud,
} from "@/domains/expenses/schema";
import { EXPENSE_CATEGORY_LABELS } from "@/domains/expenses/service";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseItem } from "@/domains/expenses/types";
import { EXPENSE_NOTE_MAX } from "@/domains/expenses/schema";
import { cn } from "@/lib/cn";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmitted: (item: ExpenseItem) => void;
  onFailed: (message: string) => void;
}

type Receipt =
  | { status: "none" }
  | { status: "resizing" }
  | { status: "ready"; dataUrl: string };

/**
 * Phil — Submit a receipt (#536). Photo-first, one-handed, worker language.
 *
 *   1. Receipt photo   required (camera) — resized client-side before upload
 *   2. Amount          $ input → parsed to exact cents (centsFromDollarInput)
 *   3. What was it for  category grid (Fuel / Parking / Materials / Tolls / Other)
 *   4. Note             optional, ≤ EXPENSE_NOTE_MAX
 *
 * Two-step submit (mirrors capture): upload the receipt → create the expense.
 * An idempotency key (per open) makes a retry after a dropped response safe —
 * it never double-submits. The receipt URL is only ever claimed once both the
 * upload AND the create succeed (P7 — no fabricated save).
 */
export function SubmitExpenseSheet({ open, onClose, onSubmitted, onFailed }: Props) {
  const [receipt, setReceipt] = useState<Receipt>({ status: "none" });
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const idemKeyRef = useRef<string>("");

  // Re-seed on open so a previous session never leaks in; mint a fresh
  // idempotency key for this submission attempt.
  useEffect(() => {
    if (open) {
      setReceipt({ status: "none" });
      setAmount("");
      setCategory(null);
      setNote("");
      setBusy(false);
      setErrorMessage(null);
      idemKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `exp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const onPickReceipt = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setErrorMessage(null);
    setReceipt({ status: "resizing" });
    try {
      const dataUrl = await resizeImageToDataUrl(file, 1920, 0.7);
      setReceipt({ status: "ready", dataUrl });
    } catch {
      setReceipt({ status: "none" });
      setErrorMessage("Couldn't read that photo — try taking it again.");
    }
  }, []);

  const amountCents = centsFromDollarInput(amount);
  const amountValid =
    amountCents !== null && amountCents >= 1 && amountCents <= EXPENSE_AMOUNT_MAX_CENTS;
  const canSubmit =
    !busy && receipt.status === "ready" && amountValid && category !== null;

  const handleSubmit = useCallback(async () => {
    if (busy || receipt.status !== "ready" || !category || amountCents === null) return;
    setBusy(true);
    setErrorMessage(null);

    const up = await uploadReceiptPhoto(receipt.dataUrl);
    if (!up.ok) {
      setBusy(false);
      const message = "Couldn't upload the receipt photo — check your signal and try again.";
      setErrorMessage(message);
      onFailed(message);
      return;
    }

    const r = await submitExpense({
      amountCents,
      category,
      note: note.trim() ? note.trim() : null,
      receiptPhotoId: up.data.id,
      receiptPhotoUrl: up.data.url,
      idempotencyKey: idemKeyRef.current,
    });
    setBusy(false);
    if (r.ok) {
      onSubmitted(r.data.expense);
      onClose();
    } else {
      const message = r.error.message || "Couldn't submit your receipt. Try again.";
      setErrorMessage(message);
      onFailed(message);
    }
  }, [busy, receipt, category, amountCents, note, onSubmitted, onClose, onFailed]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Submit a receipt"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-accent-ink/40"
    >
      <div className="flex h-full w-full flex-col bg-surface sm:my-6 sm:h-auto sm:max-w-lg sm:rounded-card sm:shadow-raised">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ReceiptText aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            <h2 className="font-display text-lg text-text">Submit a receipt</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle disabled:opacity-50"
            aria-label="Close"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <Field label="Photo of the receipt" required>
            {receipt.status === "ready" ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={receipt.dataUrl}
                  alt="Receipt preview"
                  className="h-20 w-20 rounded-card border border-border object-cover"
                />
                <label className="cursor-pointer text-sm font-semibold text-brand-navy">
                  Retake
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => void onPickReceipt(e.target.files?.[0])}
                  />
                </label>
              </div>
            ) : (
              <label
                className={cn(
                  "flex h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border text-text-muted",
                  receipt.status === "resizing" && "opacity-60",
                )}
              >
                <Camera aria-hidden="true" className="h-7 w-7" />
                <span className="text-sm font-semibold">
                  {receipt.status === "resizing" ? "Reading photo…" : "Take a photo of the receipt"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={(e) => void onPickReceipt(e.target.files?.[0])}
                />
              </label>
            )}
          </Field>

          <Field label="How much was it?" required>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-text-muted">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                aria-label="Amount in dollars"
                className="h-12 w-full rounded-card border border-border bg-surface pl-7 pr-3 text-base text-text outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20"
              />
            </div>
            {amount.trim() !== "" && !amountValid ? (
              <p className="mt-1 text-xs text-state-danger">Enter a dollar amount, e.g. 42.50</p>
            ) : amountValid ? (
              <p className="mt-1 text-xs text-text-muted">{formatAud(amountCents!)}</p>
            ) : null}
          </Field>

          <Field label="What was it for?" required>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Category">
              {EXPENSE_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={category === c}
                  onClick={() => setCategory(c)}
                  className={cn(
                    "rounded-card border px-2 py-3 text-center font-display text-sm font-semibold transition-colors",
                    category === c
                      ? "border-brand-navy bg-brand-navy text-text-inverse"
                      : "border-border bg-surface text-text hover:bg-surface-subtle",
                  )}
                >
                  {EXPENSE_CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Note (optional)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={EXPENSE_NOTE_MAX}
              rows={3}
              placeholder="What did you buy? Which job, if it matters?"
              className="w-full rounded-card border border-border bg-surface p-3 text-base text-text outline-none focus:border-brand-navy focus:ring-2 focus:ring-brand-navy/20"
            />
          </Field>

          {errorMessage ? (
            <PhilNotice tone="danger" role="alert">
              {errorMessage}
            </PhilNotice>
          ) : null}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <PhilActionButton size="lg" disabled={!canSubmit} onClick={handleSubmit} aria-busy={busy}>
            {busy ? "Sending…" : "Submit for reimbursement"}
          </PhilActionButton>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-display text-sm font-semibold text-text">
        {label}
        {required ? <span className="ml-1 text-state-danger">*</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
