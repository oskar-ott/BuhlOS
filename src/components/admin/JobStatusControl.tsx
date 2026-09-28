"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { updateJob } from "@/domains/jobs/client";
import { statusLabel } from "@/domains/jobs/format";
import { GRACE_DAYS, jobPhase, phaseLabel, phaseTone, shortDay } from "@/domains/jobs/lifecycle";
import { cn } from "@/lib/cn";
import type { Job, JobStatus } from "@/domains/jobs/types";

/**
 * Job status control on the hub's health band (2026-08-09 job-hub audit):
 * the status pill IS the control. Admin tier gets a menu of the real
 * statuses; everyone else sees the plain pill — the LH tier can't change
 * status anyway (api/jobs.js 403s the field on a leadingHand PUT), so a
 * dead control is never rendered. Lean reset keeps the vocabulary to the
 * five statuses the schema already has.
 *
 * Lifecycle (docs/job-lifecycle.md): "Complete" is the finish line. It is
 * intentionally easy but never silent — picking it (or Archived) shows a
 * one-line confirm that says what actually happens: the crew keep the job
 * in their lists for GRACE_DAYS of callback hours, it stays searchable, and
 * it can be reopened any time. Reopen is just picking Active again. No
 * closeout wizard: closing a job changes its prominence, not its record.
 *
 * On a phone (below `sm`) the menu and the confirm step are a BOTTOM SHEET,
 * not a dropdown (owner pull 2026-09-27, office on a phone): the dropdown was
 * anchored inside the hero card's overflow-hidden box and the last choices
 * (Draft, Archived) were clipped off — unreachable on a phone. A fixed sheet
 * escapes the card's clip, sits above the tab bar, and gives each choice a
 * 44px row. Desktop keeps the anchored dropdown byte-for-byte.
 */

/** Menu order: the working states first, terminal states last. */
const STATUS_CHOICES: ReadonlyArray<{ status: JobStatus; hint: string }> = [
  { status: "active", hint: "Live — in the crew's job list" },
  { status: "on_hold", hint: "Paused — shows as needing attention" },
  { status: "complete", hint: `Finished — crew can still log to it for ${GRACE_DAYS} days` },
  { status: "draft", hint: "Office-only — hidden from the field" },
  { status: "archived", hint: "History only — crew can't open or log to it" },
];

/** Statuses whose pick asks first (an outward-facing change for the crew). */
const CONFIRMED: ReadonlySet<JobStatus> = new Set(["complete", "archived"]);

/**
 * The floating-panel geometry, shared by the menu and the confirm step:
 * phone = bottom sheet (fixed, full-width, above the tab bar, safe-area
 * padded); `sm`+ = the dropdown anchored under the pill, exactly as before.
 * Exported so the render test can pin the phone contract — the panels only
 * mount on interaction, which server rendering can't drive.
 */
export const STATUS_PANEL_CLASS =
  "fixed inset-x-0 bottom-0 z-50 rounded-t-card border-t border-border bg-surface-raised shadow-raised pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:z-20 sm:mt-1.5 sm:rounded-card sm:border sm:pb-0 sm:shadow-card";

function confirmCopy(status: JobStatus, from: JobStatus): string {
  if (status === "complete") {
    const until = shortDay(
      new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      true
    );
    return `Mark this job finished? The crew can keep logging hours to it until ${until}; after that it leaves their list but stays in search, still takes callback hours, and can be reopened any time.`;
  }
  // archived
  return from === "complete"
    ? "Archive this job? It leaves every list except the office's Archived history, and the crew can no longer open it or log hours to it. Nothing is deleted; you can restore it here."
    : "Archive this job? It is not marked finished — it just disappears from every list except the office's Archived history, and the crew can no longer open or log to it. Nothing is deleted.";
}

export function JobStatusControl({
  job,
  canEdit,
}: {
  job: Pick<Job, "id" | "status" | "completedAt" | "reopenedAt">;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current: JobStatus = job.status ?? "active";
  const phase = jobPhase(job);

  const pill = (
    <Pill tone={phaseTone(phase)}>
      {current === "complete" ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : null}
      {phaseLabel(phase)}
    </Pill>
  );

  if (!canEdit) return pill;

  async function apply(status: JobStatus) {
    setBusy(true);
    setError(null);
    const result = await updateJob({ id: job.id, status });
    setBusy(false);
    if (!result.ok) {
      setError("Couldn't change the status — try again.");
      return;
    }
    setConfirming(null);
    setOpen(false);
    router.refresh();
  }

  function pick(status: JobStatus) {
    if (status === current) {
      setOpen(false);
      return;
    }
    if (CONFIRMED.has(status)) {
      setConfirming(status);
      setOpen(false);
      return;
    }
    void apply(status);
  }

  const panelOpen = open || confirming !== null;

  return (
    <div className="relative">
      {/* Phone: a 44px hit area around the small pill without moving it
          (negative vertical margin keeps the band's top row height). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Job status: ${statusLabel(job.status)}. Change status`}
        className="-my-2.5 inline-flex min-h-[44px] items-center gap-1 rounded-pill focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60 sm:my-0 sm:min-h-0"
      >
        {pill}
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
      </button>

      {panelOpen ? (
        // Click-away backdrop — closes the menu without stealing focus styling.
        // Dimmed on a phone so the sheet reads as a sheet; invisible on desktop.
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className="fixed inset-0 z-40 cursor-default bg-accent-ink/40 sm:z-10 sm:bg-transparent"
          onClick={() => {
            setOpen(false);
            setConfirming(null);
          }}
        />
      ) : null}

      {open ? (
        <div
          role="menu"
          aria-label="Change job status"
          data-testid="job-status-menu"
          className={cn(STATUS_PANEL_CLASS, "p-2 sm:w-72 sm:p-1")}
        >
          <p className="px-2.5 pb-1 pt-2 font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted sm:hidden">
            Change status
          </p>
          {STATUS_CHOICES.map(({ status, hint }) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={status === current}
              disabled={busy}
              onClick={() => pick(status)}
              data-testid={`job-status-pick-${status}`}
              className={cn(
                "flex min-h-[44px] w-full items-start gap-2 rounded-card px-2.5 py-2 text-left transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none disabled:opacity-60 sm:min-h-0",
                status === current ? "bg-surface-subtle" : ""
              )}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">
                  {status === "active" && current === "complete" ? "Reopen" : statusLabel(status)}
                </span>
                <span className="block text-xs text-text-muted">
                  {status === "active" && current === "complete"
                    ? "Back to live — the crew see it as a normal job again"
                    : hint}
                </span>
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
      ) : null}

      {confirming ? (
        <div
          role="dialog"
          aria-label={`Confirm: ${statusLabel(confirming)}`}
          data-testid="job-status-confirm"
          className={cn(STATUS_PANEL_CLASS, "p-4 sm:w-80 sm:p-3")}
        >
          <p className="text-sm text-text">{confirmCopy(confirming, current)}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void apply(confirming)}
              data-testid="job-status-confirm-yes"
            >
              {busy ? "Saving…" : confirming === "complete" ? "Yes, mark finished" : "Yes, archive"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="fixed inset-x-4 bottom-20 z-50 rounded-card border border-state-danger-subtle-border bg-state-danger-subtle-bg px-2.5 py-1.5 text-xs text-state-danger-subtle-text sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:z-20 sm:mt-1.5 sm:w-56"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
