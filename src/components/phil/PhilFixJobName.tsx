"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, SquarePen } from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilActionButton } from "./ui/PhilActionButton";
import { philWrite } from "@/domains/phil/write-client";
import type { Job } from "@/domains/jobs/types";

/**
 * Phil — "Wrong job name? Fix it" (owner ruling 2026-08-31: whoever can add
 * a job can fix its name).
 *
 * The field CREATE (+ New job, phil_sharpened) lets a worker mint a job, so a
 * typo'd name must be fixable from the same phone. One quiet text row at the
 * very bottom of the job page's reference zone (P10 — a rare corrective
 * action buys the cheapest slot on the page; the hero keeps its "no icons
 * next to the name" rule) opening a focused full-screen sheet (the
 * PhilNewJobSheet overlay precedent) with ONE input.
 *
 * Server contract (api/jobs.js PUT): a field worker may send {id, name} and
 * NOTHING else, only on an assigned job, only while phil_sharpened is on —
 * LH/admin pass on their tier. The rename lands in the job audit trail with
 * the worker as actor. Non-optimistic (P7): the sheet closes only on a
 * confirmed reply, then router.refresh() repaints the hero from server truth.
 * PUT {id,name} is idempotent, so after a timeout a retry is safe (the #497
 * caveat in write-client.ts doesn't bite here).
 *
 * Cross-ref:
 *   src/components/phil/PhilNewJobSheet.tsx — the create this corrects
 *   src/domains/jobs/jobs-phil-create-api.test.ts — the PUT contract
 */

function parseUpdated(raw: unknown): { name: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const job = (raw as { job?: unknown }).job;
  if (!job || typeof job !== "object") return null;
  const name = (job as { name?: unknown }).name;
  return typeof name === "string" && name ? { name } : null;
}

export function PhilFixJobName({
  job,
  defaultOpen = false,
}: {
  job: Pick<Job, "id" | "name">;
  /** Start with the sheet open (render tests only). */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState(job.name ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = useCallback(() => {
    setName(job.name ?? "");
    setError(null);
    setOpen(true);
  }, [job.name]);

  const onClose = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [submitting]);

  // Escape closes, matching the dialog affordance (Cancel stays the visible
  // path — glove-sized, top-left).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== (job.name ?? "").trim() && !submitting;

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    const result = await philWrite("/api/jobs", { id: job.id, name: trimmed }, parseUpdated, {
      method: "PUT",
    });
    if (result.ok) {
      // Confirmed on the server — repaint the hero (and everything else)
      // from server truth, then close. No optimistic rename.
      router.refresh();
      setSubmitting(false);
      setOpen(false);
      return;
    }
    setError(result.error.message || "Couldn't save the name. Try again.");
    setSubmitting(false);
  }, [canSave, job.id, trimmed, router]);

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        data-testid="phil-fix-job-name-open"
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-card px-1 text-sm text-text-muted underline decoration-border decoration-2 underline-offset-4 transition-colors hover:text-text focus-visible:outline-brand-navy"
      >
        <SquarePen aria-hidden="true" className="h-4 w-4" />
        Wrong job name? Fix it
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Fix job name"
          data-testid="phil-fix-job-name-sheet"
          className="fixed inset-0 z-50 flex flex-col bg-surface pb-[env(safe-area-inset-bottom)]"
        >
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-raised px-2 py-1.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              data-testid="phil-fix-job-name-cancel"
              className="inline-flex min-h-[44px] items-center gap-0.5 rounded-card px-2 text-[15px] font-medium text-brand-navy hover:bg-surface-subtle focus-visible:outline-brand-navy disabled:opacity-60"
            >
              <ChevronLeft aria-hidden="true" className="h-5 w-5" />
              Cancel
            </button>
            <h2 className="font-display text-base font-bold text-text">Fix job name</h2>
            {/* Spacer balances the Cancel button so the title sits centred. */}
            <span aria-hidden="true" className="w-[84px]" />
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto max-w-lg space-y-5">
              {error ? (
                <PhilNotice tone="danger" role="alert">
                  {error}
                </PhilNotice>
              ) : null}

              <div className="space-y-1.5">
                <label
                  htmlFor="phil-fix-job-name-input"
                  className="font-display text-[13px] font-bold text-text"
                >
                  Job name
                </label>
                <input
                  id="phil-fix-job-name-input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  autoFocus
                  className="h-[54px] w-full rounded-card border border-border bg-surface-raised px-4 text-base text-text outline-none focus:border-brand-navy"
                />
                <p className="text-[12px] leading-relaxed text-text-muted">
                  Changes it for everyone — the office sees the new name too.
                </p>
              </div>

              <PhilActionButton
                size="lg"
                onClick={() => void onSave()}
                disabled={!canSave}
                data-testid="phil-fix-job-name-save"
              >
                {submitting ? "Saving…" : "Save name"}
              </PhilActionButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
