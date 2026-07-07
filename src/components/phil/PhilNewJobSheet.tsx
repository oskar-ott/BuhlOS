"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, Link2, Loader2, MapPin, SquarePen, Wand2 } from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import { philWrite } from "@/domains/phil/write-client";
import { cn } from "@/lib/cn";
import {
  CODE_PREFIX,
  canCreateJobInput,
  codeFromDigits,
  nextFree7000,
  sanitizeDigits,
} from "./philNewJobForm";

/**
 * "+ New job" — the sharpened Jobs screen's focused create form (Wave 2b,
 * phil_sharpened dark; prototype §2.2). In-page client state on /phil/jobs —
 * NO new route: a full-screen overlay (fixed inset-0 z-50, the CaptureSheet
 * precedent) that visually covers the global tab bar while open.
 *
 * HONEST version of the prototype (P7 — no fake integration):
 *   - No "Found" state and no "pulls site/client/quote" claim — there is no
 *     ServiceMate integration in this product. The ServiceMate side is just
 *     "type the number off the ServiceMate job" so refs line up.
 *   - "Recent" chips only when REAL codes exist on the worker's own job list,
 *     shown as reference ("already on your list") — they're taken, so they
 *     are deliberately NOT tap-to-fill (a fill would guarantee a duplicate
 *     the server 409s).
 *   - Custom default = the real next free 7000-series number computed from
 *     the worker's actual list; the server validates format + uniqueness
 *     globally anyway.
 *
 * Writes via philWrite (non-optimistic — the job exists only on a confirmed
 * server reply); server errors (duplicate code etc.) surface as inline
 * honest errors with every input preserved.
 */

export type NewJobCodeMode = "servicemate" | "custom";

interface PhilNewJobSheetProps {
  open: boolean;
  /** Cancel / after-create dismissal — returns to the list. */
  onClose: () => void;
  /** REAL IV#### codes on the worker's job list (drives the reference row +
   *  the next-free-7000 default). Empty for most workers today. */
  existingCodes: ReadonlyArray<string>;
  /** Initial toggle side. Default ServiceMate (the prototype's lead side). */
  initialMode?: NewJobCodeMode;
}

interface CreatedJob {
  id: string;
}

function parseCreated(raw: unknown): CreatedJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = (raw as { job?: unknown }).job;
  if (!job || typeof job !== "object") return null;
  const id = (job as { id?: unknown }).id;
  return typeof id === "string" && id ? { id } : null;
}

export function PhilNewJobSheet({
  open,
  onClose,
  existingCodes,
  initialMode = "servicemate",
}: PhilNewJobSheetProps) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [mode, setMode] = useState<NewJobCodeMode>(initialMode);
  // Separate digit slots per side so toggling never wipes an entry.
  const [smDigits, setSmDigits] = useState("");
  const nextFree = useMemo(() => nextFree7000(existingCodes), [existingCodes]);
  const [customDigits, setCustomDigits] = useState(nextFree ?? "");
  const [siteAddress, setSiteAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes, matching the dialog affordance (Cancel stays the visible
  // path — glove-sized, top-left).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, submitting]);

  const digits = mode === "servicemate" ? smDigits : customDigits;
  const canCreate = canCreateJobInput(name, digits) && !submitting;

  const onNextFree = useCallback(() => {
    setCustomDigits(nextFree7000(existingCodes) ?? "");
  }, [existingCodes]);

  const onSubmit = useCallback(async () => {
    if (!canCreateJobInput(name, digits) || submitting) return;
    setSubmitting(true);
    setError(null);
    const body: Record<string, string> = {
      name: name.trim(),
      code: codeFromDigits(digits),
    };
    if (siteAddress.trim()) body.siteAddress = siteAddress.trim();
    const result = await philWrite("/api/jobs", body, parseCreated);
    if (result.ok) {
      // Keep `submitting` true through the navigation — no double-create tap.
      router.push(`/phil/jobs/${encodeURIComponent(result.data.id)}`);
      return;
    }
    setError(result.error.message || "Couldn't create the job. Try again.");
    setSubmitting(false);
  }, [name, digits, siteAddress, submitting, router]);

  if (!open) return null;

  const referenceCodes = existingCodes.slice(0, 3);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New job"
      data-testid="phil-new-job-sheet"
      className="fixed inset-0 z-50 flex flex-col bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {/* Header — Cancel returns to the list; title centred (prototype §2.2). */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-raised px-2 py-1.5">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="phil-new-job-cancel"
          className="inline-flex min-h-[44px] items-center gap-0.5 rounded-card px-2 text-[15px] font-medium text-brand-navy hover:bg-surface-subtle focus-visible:outline-brand-navy disabled:opacity-60"
        >
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
          Cancel
        </button>
        <h2 className="font-display text-base font-bold text-text">New job</h2>
        {/* Spacer balances the Cancel button so the title sits centred. */}
        <span aria-hidden="true" className="w-[84px]" />
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-lg space-y-5">
          {error ? (
            <PhilNotice tone="danger" role="alert">
              {error}
            </PhilNotice>
          ) : null}

          {/* Job name */}
          <div className="space-y-1.5">
            <label
              htmlFor="phil-new-job-name"
              className="font-display text-[13px] font-bold text-text"
            >
              Job name
            </label>
            <input
              id="phil-new-job-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What's the site called?"
              maxLength={120}
              className="h-[54px] w-full rounded-card border border-border bg-surface-raised px-4 text-base text-text outline-none focus:border-brand-navy"
            />
          </div>

          {/* Job code */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-display text-[13px] font-bold text-text">Job code</span>
              <span className="text-[12px] text-text-muted">format IV0000</span>
            </div>

            {/* Segmented toggle — ServiceMate | Custom number */}
            <div
              role="group"
              aria-label="Job code source"
              className="flex gap-1 rounded-card border border-border bg-surface-subtle p-1"
            >
              <button
                type="button"
                data-testid="phil-new-job-mode-servicemate"
                aria-pressed={mode === "servicemate"}
                onClick={() => setMode("servicemate")}
                className={cn(
                  "flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-[9px] font-display text-sm font-semibold transition focus-visible:outline-brand-navy",
                  mode === "servicemate"
                    ? "bg-brand-navy text-text-inverse"
                    : "text-text-muted hover:bg-surface-raised",
                )}
              >
                <Link2 aria-hidden="true" className="h-4 w-4" />
                ServiceMate
              </button>
              <button
                type="button"
                data-testid="phil-new-job-mode-custom"
                aria-pressed={mode === "custom"}
                onClick={() => setMode("custom")}
                className={cn(
                  "flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-[9px] font-display text-sm font-semibold transition focus-visible:outline-brand-navy",
                  mode === "custom"
                    ? "bg-brand-navy text-text-inverse"
                    : "text-text-muted hover:bg-surface-raised",
                )}
              >
                <SquarePen aria-hidden="true" className="h-4 w-4" />
                Custom number
              </button>
            </div>

            {/* Code input — IV prefix locked, 4 digits */}
            <div className="flex h-[54px] items-stretch overflow-hidden rounded-card border border-border bg-surface-raised focus-within:border-brand-navy">
              <span
                aria-hidden="true"
                className="inline-flex items-center border-r border-border bg-surface-subtle px-4 font-mono text-base font-semibold tracking-[0.06em] text-brand-navy"
              >
                {CODE_PREFIX}
              </span>
              {mode === "servicemate" ? (
                <input
                  key="sm"
                  aria-label="ServiceMate job number (4 digits)"
                  data-testid="phil-new-job-digits-servicemate"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={smDigits}
                  onChange={(e) => setSmDigits(sanitizeDigits(e.target.value))}
                  placeholder="0000"
                  className="min-w-0 flex-1 bg-transparent px-4 font-mono text-base tracking-[0.1em] text-text outline-none [font-variant-numeric:tabular-nums]"
                />
              ) : (
                <>
                  <input
                    key="custom"
                    aria-label="Custom job number (4 digits, 7000s)"
                    data-testid="phil-new-job-digits-custom"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={customDigits}
                    onChange={(e) => setCustomDigits(sanitizeDigits(e.target.value))}
                    placeholder="7001"
                    className="min-w-0 flex-1 bg-transparent px-4 font-mono text-base tracking-[0.1em] text-text outline-none [font-variant-numeric:tabular-nums]"
                  />
                  <button
                    type="button"
                    onClick={onNextFree}
                    data-testid="phil-new-job-next-free"
                    className="inline-flex shrink-0 items-center gap-1.5 border-l border-border bg-surface-subtle px-4 text-[13px] font-semibold text-brand-navy hover:brightness-95 focus-visible:outline-brand-navy"
                  >
                    <Wand2 aria-hidden="true" className="h-3.5 w-3.5" />
                    Next free
                  </button>
                </>
              )}
            </div>

            {mode === "servicemate" ? (
              <>
                {/* Reference row — REAL codes off the worker's own list only;
                    hidden when there are none. Not tap-to-fill: these are
                    taken, filling one would just earn an honest 409. */}
                {referenceCodes.length > 0 ? (
                  <p
                    data-testid="phil-new-job-recent-codes"
                    className="text-[12px] text-text-muted"
                  >
                    Already on your list:{" "}
                    <span className="font-mono font-semibold text-text [font-variant-numeric:tabular-nums]">
                      {referenceCodes.join(" · ")}
                    </span>
                  </p>
                ) : null}
                <p className="text-[13px] leading-relaxed text-text-muted">
                  Use the ServiceMate job number so hours and invoices line up under
                  the one ref.
                </p>
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-text-muted">
                Your own ref, in the 7000s so it never clashes with a ServiceMate
                code. The office can match it to ServiceMate later.
              </p>
            )}
          </div>

          {/* Site address (optional) */}
          <div className="space-y-1.5">
            <label
              htmlFor="phil-new-job-address"
              className="font-display text-[13px] font-bold text-text"
            >
              Site address
            </label>
            <div className="flex h-[54px] items-center gap-2.5 rounded-card border border-border bg-surface-raised px-4 focus-within:border-brand-navy">
              <MapPin aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
              <input
                id="phil-new-job-address"
                type="text"
                value={siteAddress}
                onChange={(e) => setSiteAddress(e.target.value)}
                placeholder="Where is it?"
                maxLength={240}
                className="min-w-0 flex-1 bg-transparent text-base text-text outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Sticky create — the one primary action on this screen. */}
      <div className="shrink-0 border-t border-border bg-surface-raised px-4 pb-4 pt-3">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canCreate}
          data-testid="phil-new-job-create"
          className={cn(
            "flex h-[52px] w-full items-center justify-center gap-2 rounded-card",
            "bg-brand-navy font-display text-[17px] font-bold text-text-inverse",
            "transition hover:brightness-110 active:scale-[0.99]",
            "focus-visible:outline-brand-navy",
            "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
          )}
        >
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
              Creating…
            </>
          ) : (
            <>
              <Check aria-hidden="true" className="h-5 w-5" />
              Create job
            </>
          )}
        </button>
      </div>
    </div>
  );
}
