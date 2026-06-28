"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { updateJob } from "@/domains/jobs/client";
import { dlpStatus } from "@/domains/jobs/dlp";
import type { Job } from "@/domains/jobs/types";

/**
 * Defect liability period (DLP) card on the job hub (#235).
 *
 * Shows the in-DLP status + days remaining, or "Defect period ended <date>" —
 * driven entirely by dlpStatus(job, today). When neither date is set the
 * status line renders nothing (a not-set job behaves exactly as today, AC#5)
 * but the admin edit affordance still shows so the office can set the window.
 *
 * Admin-tier ONLY: the handover / defect-period dates are admin-tier writes
 * (api/jobs.js 403s a leadingHand PUT of them), so render this card only for
 * the admin viewer (the page gates on canBuild). Saved as its OWN PUT — the
 * ClientContractSection precedent — so an unrelated Basics save can't clobber
 * it and vice-versa.
 *
 * `today` is passed from the server (Sydney YYYY-MM-DD) so the status line is
 * deterministic with the server render — no hydration drift.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD → "1 Aug 2026" for display. Falls back to the raw string. */
function prettyDate(ymd: string): string {
  if (!YMD.test(ymd)) return ymd;
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function JobDlpCard({ job, today }: { job: Job; today: string }) {
  const router = useRouter();
  const [handoverDate, setHandoverDate] = useState(job.handoverDate ?? "");
  const [defectPeriodEndsAt, setDefectPeriodEndsAt] = useState(
    job.defectPeriodEndsAt ?? "",
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const touch = () => {
    setDirty(true);
    setSavedAt(null);
  };

  // Mirror the server cross-field rule so we never send a PUT the server 400s.
  const crossInvalid =
    !!handoverDate && !!defectPeriodEndsAt && defectPeriodEndsAt < handoverDate;

  // Status line is computed off the SAVED job (not the in-progress inputs) so it
  // reflects what's actually stored until a save lands + router.refresh()es.
  const status = dlpStatus(job, today);

  async function save() {
    if (crossInvalid) return;
    setBusy(true);
    setError(null);
    const res = await updateJob({
      id: job.id,
      handoverDate: handoverDate.trim() || null,
      defectPeriodEndsAt: defectPeriodEndsAt.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setDirty(false);
    setSavedAt(new Date().toISOString());
    router.refresh();
  }

  return (
    <Card role="region" aria-label="Defect liability period">
      <div className="flex items-start gap-2">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 text-text-muted" />
        <div className="min-w-0 flex-1">
          <CardTitle>Defect liability period</CardTitle>
          <CardDescription className="mt-1">
            The handover date and defect window. Defects raised in the window are
            tracked as snags marked post-handover.
          </CardDescription>
        </div>
      </div>

      {/* Status line — nothing when not set (a not-set job reads as today). */}
      {status.state === "in_dlp" ? (
        <p className="mt-3" data-testid="dlp-status">
          <Pill tone="warning">
            In defect period — {status.daysRemaining} day
            {status.daysRemaining === 1 ? "" : "s"} left
          </Pill>
        </p>
      ) : status.state === "expired" ? (
        <p className="mt-3" data-testid="dlp-status">
          <Pill tone="neutral">
            Defect period ended {prettyDate(status.endedAt)}
          </Pill>
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-text">Handover date</span>
          <input
            type="date"
            value={handoverDate}
            onChange={(e) => {
              setHandoverDate(e.target.value);
              touch();
            }}
            className="mt-1 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
            data-testid="dlp-handover"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-text">Defect period ends</span>
          <input
            type="date"
            value={defectPeriodEndsAt}
            min={handoverDate || undefined}
            onChange={(e) => {
              setDefectPeriodEndsAt(e.target.value);
              touch();
            }}
            className="mt-1 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
            data-testid="dlp-ends"
          />
        </label>
      </div>

      {crossInvalid ? (
        <p className="mt-1 text-xs text-rose-700">
          The defect period must end on or after the handover date.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={busy || !dirty || crossInvalid}
          data-testid="dlp-save"
        >
          {busy ? "Saving…" : "Save defect period"}
        </Button>
        {savedAt ? <span className="text-xs text-state-success">Saved.</span> : null}
      </div>
    </Card>
  );
}
