"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { updateJob } from "@/domains/jobs/client";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import type { Job, JobStatus } from "@/domains/jobs/types";

/**
 * Job status pill + change menu on the job hub's health band.
 *
 * The hub had NO way to move a job through its lifecycle — complete, hold,
 * archive all required a trip into the builder (2026-08-09 job-hub audit,
 * finding B9). `status` is a writable shallow field on PUT /api/jobs and is
 * admin-gated server-side (the publishJob/unpublishJob precedent), so this
 * control is the thinnest possible lifecycle surface: pick a status, PUT it,
 * refresh. Non-admin viewers get the static pill — the menu never renders,
 * and the server would 403 a forbidden write anyway.
 *
 * Complete carries a check icon so a finished job reads differently from a
 * live one at a glance — both share the success tone per doc 27 §6.1, which
 * this deliberately does not amend.
 */

/** Menu order: the working states first, terminal states last. */
const STATUS_CHOICES: ReadonlyArray<{ status: JobStatus; hint: string }> = [
  { status: "active", hint: "Live — visible to assigned crew" },
  { status: "on_hold", hint: "Paused — shows as needing attention" },
  { status: "complete", hint: "Work finished" },
  { status: "draft", hint: "Office-only — hidden from the field" },
  { status: "archived", hint: "Hidden from job lists" },
];

export function JobStatusControl({
  job,
  canEdit,
}: {
  job: Pick<Job, "id" | "status">;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current: JobStatus = job.status ?? "active";

  const pill = (
    <Pill tone={statusTone(job.status)}>
      {current === "complete" ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : null}
      {statusLabel(job.status)}
    </Pill>
  );

  if (!canEdit) return pill;

  async function pick(status: JobStatus) {
    if (status === current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateJob({ id: job.id, status });
    setBusy(false);
    if (!result.ok) {
      setError("Couldn't change the status — try again.");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Job status: ${statusLabel(job.status)}. Change status`}
        className="inline-flex items-center gap-1 rounded-pill focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60"
      >
        {pill}
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
      </button>

      {open ? (
        <>
          {/* Click-away backdrop — closes the menu without stealing focus styling. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label="Change job status"
            className="absolute right-0 z-20 mt-1.5 w-64 rounded-card border border-border bg-surface-raised p-1 shadow-card"
          >
            {STATUS_CHOICES.map(({ status, hint }) => (
              <button
                key={status}
                type="button"
                role="menuitemradio"
                aria-checked={status === current}
                disabled={busy}
                onClick={() => void pick(status)}
                className={`flex w-full items-start gap-2 rounded-card px-2.5 py-2 text-left transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none disabled:opacity-60 ${
                  status === current ? "bg-surface-subtle" : ""
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{statusLabel(status)}</span>
                  <span className="block text-xs text-text-muted">{hint}</span>
                </span>
                {status === current ? (
                  <CheckCircle2
                    aria-hidden="true"
                    className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-text-muted"
                  />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {error ? (
        <p
          className="absolute right-0 z-20 mt-1.5 w-56 rounded-card border border-state-danger-subtle-border bg-state-danger-subtle-bg px-2.5 py-1.5 text-xs text-state-danger-subtle-text"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
