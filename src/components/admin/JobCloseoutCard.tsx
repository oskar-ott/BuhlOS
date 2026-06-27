"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  closeOutJob,
  closeoutStatus,
  reopenJob,
  type CloseoutSnapshot,
} from "@/domains/jobs/closeout-client";
import { formatMoneyCents } from "@/domains/jobs/profitability-client";

/**
 * Job closeout / "Final numbers" report card (#349) on the admin job hub.
 *
 * - Active job: a Close out action that freezes the snapshot (status → complete).
 * - Complete / archived job: the frozen report card + a Reopen action (complete)
 *   or a backfill action (archived with no closeout recorded).
 * - Admin-tier only (the endpoint 403s otherwise → the card hides rather than
 *   showing an error to an LH). Honest-empty: missing inputs are named, never
 *   zero-filled.
 */

export function JobCloseoutCard({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CloseoutSnapshot | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "hidden">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await closeoutStatus(jobId);
      if (cancelled) return;
      if (!res.ok) {
        setView("hidden"); // 403 (non-admin) or error → don't show a money surface
        return;
      }
      setStatus(res.data.status);
      setSnapshot(res.data.latest);
      setView("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (view === "hidden") return null;

  async function doClose() {
    setBusy(true);
    setError(null);
    const res = await closeOutJob(jobId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setStatus(res.data.status);
    if (res.data.snapshot) setSnapshot(res.data.snapshot);
  }

  async function doReopen() {
    setBusy(true);
    setError(null);
    const res = await reopenJob(jobId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setStatus(res.data.status);
  }

  const isComplete = status === "complete";
  const isArchived = status === "archived";

  return (
    <Card role="region" aria-label="Job closeout">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>{snapshot ? "Final numbers" : "Closeout"}</CardTitle>
        {isComplete ? <Pill tone="neutral">Complete</Pill> : null}
      </div>

      {view === "loading" ? (
        <p className="mt-2 text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          {error ? (
            <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              {error}
            </p>
          ) : null}

          {snapshot ? (
            <ReportCard snapshot={snapshot} />
          ) : isArchived ? (
            <p className="mt-2 text-sm text-text-muted">
              No closeout recorded — this job was archived before its final numbers
              were frozen.
            </p>
          ) : (
            <p className="mt-2 text-sm text-text-muted">
              Closing out freezes this job&rsquo;s final numbers as a permanent report
              card the next quote can learn from.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {!isComplete ? (
              <Button size="sm" onClick={doClose} disabled={busy} data-testid="job-closeout-close">
                {isArchived ? "Record closeout (backfill)" : "Close out this job"}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={doReopen} disabled={busy} data-testid="job-closeout-reopen">
                Reopen to correct
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function ReportCard({ snapshot }: { snapshot: CloseoutSnapshot }) {
  return (
    <div className="mt-3">
      {snapshot.backfilled ? (
        <p className="mb-2 text-xs text-amber-700">Backfilled — closed out after the job was already archived.</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Figure label="Contract" value={formatMoneyCents(snapshot.revenue.contractValueCents)} muted={snapshot.revenue.contractValueCents == null} />
        <Figure label="Labour" value={formatMoneyCents(snapshot.labour.costCents)} />
        <Figure label="Materials" value={snapshot.material.source === "none" ? "—" : formatMoneyCents(snapshot.material.costCents)} muted={snapshot.material.source === "none"} />
        <Figure
          label={snapshot.margin.pct == null ? "Margin" : `Margin (${snapshot.margin.pct}%)`}
          value={formatMoneyCents(snapshot.margin.cents)}
          muted={snapshot.margin.cents == null}
        />
        <Figure label="Hours" value={String(snapshot.labour.hoursTotal)} />
        <Figure
          label="Planned vs actual"
          value={
            snapshot.duration.plannedDays != null && snapshot.duration.actualDays != null
              ? `${snapshot.duration.plannedDays}d / ${snapshot.duration.actualDays}d`
              : "—"
          }
          muted={snapshot.duration.plannedDays == null || snapshot.duration.actualDays == null}
        />
        <Figure label="Snags closed" value={`${snapshot.snags.closed}/${snapshot.snags.opened}`} />
        <Figure label="Open snags" value={String(snapshot.snags.openNow)} muted={snapshot.snags.openNow === 0} />
      </dl>
      {snapshot.badges.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {snapshot.badges.map((b) => (
            <Pill key={b} tone={b.includes("unrated") || b.includes("no ") || b.includes("still open") ? "warning" : "neutral"}>
              {b}
            </Pill>
          ))}
        </div>
      ) : null}
      {snapshot.closedByName ? (
        <p className="mt-2 font-mono text-[10px] text-text-muted">
          frozen by {snapshot.closedByName}
          {snapshot.version > 1 ? ` · v${snapshot.version}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function Figure({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className={`mt-0.5 text-base font-semibold ${muted ? "text-text-muted" : "text-text"}`}>{value}</dd>
    </div>
  );
}
