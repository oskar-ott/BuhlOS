"use client";

import { useEffect } from "react";
import { Check, CheckCircle2, ChevronRight, SkipForward } from "lucide-react";
import type { ScopeClassification } from "@/domains/job-control/reconciliation";
import { cn } from "@/lib/cn";

/** Bucket a progress ratio to a STATIC Tailwind width class (the repo bans inline
 *  styles; arbitrary-value literals are build-time safe and JIT-generated). */
const WIDTH_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1, "w-full"],
  [0.875, "w-[87.5%]"],
  [0.75, "w-3/4"],
  [0.625, "w-[62.5%]"],
  [0.5, "w-1/2"],
  [0.375, "w-[37.5%]"],
  [0.25, "w-1/4"],
  [0.125, "w-[12.5%]"],
];
function barWidthClass(cleared: number, total: number): string {
  const r = total > 0 ? cleared / total : 0;
  return WIDTH_STEPS.find(([t]) => r >= t)?.[1] ?? "w-0";
}

/**
 * The cockpit's keyboard-fast scope review queue (§4).
 *
 * Triages the scope lines that aren't yet classified: one card at a time, the
 * office assigns a real reconciliation classification (or skips). Presentational
 * — it emits onClassify/onSkip/onClose; JobBuilderClient owns the session state
 * and persists each classification through the existing reconciliation confirm
 * endpoint (extend, don't fork). Every disposition is a REAL classification from
 * the domain's closed set — no invented "cert", no fake confirm.
 *
 * The keyboard map mirrors the buttons so a reviewer never has to reach for the
 * mouse: P priced · A allowance · C PC/provisional · E excluded · O by others ·
 * R reuse · V variation · space/N skip · esc close.
 */

export interface ReviewClause {
  id: string;
  title: string;
  detail: string | null;
}

interface ReviewOption {
  value: ScopeClassification;
  label: string;
  /** single-key shortcut (the common dispositions) */
  key?: string;
}

const REVIEW_OPTIONS: ReadonlyArray<ReviewOption> = [
  { value: "priced", label: "Priced field work", key: "p" },
  { value: "general_allowance", label: "General allowance", key: "a" },
  { value: "pc_provisional", label: "PC / provisional", key: "c" },
  { value: "excluded", label: "Excluded", key: "e" },
  { value: "by_others", label: "By others", key: "o" },
  { value: "reuse_existing", label: "Reuse existing", key: "r" },
  { value: "variation_trigger", label: "Variation trigger", key: "v" },
  { value: "closeout", label: "Closeout obligation" },
  { value: "admin_only", label: "Admin only" },
];

interface ReviewQueueProps {
  /** Snapshot of the clauses to triage, taken when the queue opened. */
  session: ReadonlyArray<ReviewClause>;
  /** Current position in the session. */
  index: number;
  /** How many of the session have been classified. */
  cleared: number;
  error: string | null;
  onClassify: (clauseId: string, classification: ScopeClassification) => void;
  onSkip: () => void;
  onClose: () => void;
}

export function ReviewQueue({
  session,
  index,
  cleared,
  error,
  onClassify,
  onSkip,
  onClose,
}: ReviewQueueProps) {
  const total = session.length;
  const done = index >= total;
  const current = done ? null : session[index];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!current) return;
      if (k === " " || k === "n") {
        e.preventDefault();
        onSkip();
        return;
      }
      const opt = REVIEW_OPTIONS.find((o) => o.key === k);
      if (opt) {
        e.preventDefault();
        onClassify(current.id, opt.value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, onClassify, onSkip, onClose]);

  return (
    <div data-testid="review-queue" className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-card border border-border bg-surface px-2.5 py-1.5 text-sm text-text-muted transition-colors hover:bg-surface-subtle hover:text-text"
        >
          <ChevronRight className="h-4 w-4 rotate-180" aria-hidden="true" /> Close queue
        </button>
        <div
          className="h-2 flex-1 overflow-hidden rounded-pill bg-surface-subtle"
          role="progressbar"
          aria-valuenow={cleared}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <div className={cn("h-full rounded-pill bg-brand-navy transition-all", barWidthClass(cleared, total))} />
        </div>
        <span className="shrink-0 font-mono text-xs text-text-muted">
          {cleared} of {total} classified
        </span>
      </div>

      {error ? (
        <p role="alert" className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      ) : null}

      {done ? (
        <div className="rounded-card border border-border bg-surface p-6 text-center">
          <CheckCircle2 className="mx-auto h-7 w-7 text-state-success" aria-hidden="true" />
          <h3 className="mt-2 font-display text-base font-semibold text-text">
            {total === 0 ? "Nothing to review" : "Queue cleared"}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {total === 0
              ? "Every scope line is already classified."
              : `${cleared} of ${total} classified${cleared < total ? ` · ${total - cleared} skipped, still to triage` : "."}`}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 rounded-card bg-brand-navy px-4 py-2 text-sm font-medium text-text-inverse"
          >
            Back to the builder
          </button>
        </div>
      ) : (
        <>
          <div className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                Scope line · needs review
              </span>
            </div>
            <p className="mt-1 font-display text-base font-semibold text-text">{current!.title}</p>
            {current!.detail ? (
              <p className="mt-1 text-sm text-text-muted">{current!.detail}</p>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {REVIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`review-classify-${opt.value}`}
                  onClick={() => onClassify(current!.id, opt.value)}
                  className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2 text-left text-sm text-text transition-colors hover:border-brand-navy hover:bg-surface-subtle"
                >
                  <span className="min-w-0 truncate">{opt.label}</span>
                  {opt.key ? (
                    <kbd className="shrink-0 rounded border border-border bg-surface-subtle px-1.5 font-mono text-[10px] uppercase text-text-muted">
                      {opt.key}
                    </kbd>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="review-skip"
                onClick={onSkip}
                className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-surface-subtle hover:text-text"
              >
                <SkipForward className="h-4 w-4" aria-hidden="true" /> Skip
                <kbd className="rounded border border-border bg-surface-subtle px-1.5 font-mono text-[10px] uppercase">
                  space
                </kbd>
              </button>
              <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                <Check className="mr-1 inline h-3 w-3" aria-hidden="true" />
                key or click to classify
              </span>
            </div>
          </div>

          {session.length - index > 1 ? (
            <div className="rounded-card border border-border bg-surface-subtle p-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Up next</p>
              <ul className="mt-1 space-y-1">
                {session.slice(index + 1, index + 4).map((c) => (
                  <li key={c.id} className="truncate text-sm text-text-muted">
                    {c.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
