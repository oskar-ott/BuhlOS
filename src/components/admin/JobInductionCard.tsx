"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import {
  jobInductions,
  recordInductionFor,
  type CrewInductionStatus,
} from "@/domains/jobs/induction";

/**
 * Job hub — crew induction status (#332). Answers the inspector's question
 * ("is everyone on this job inducted?") from the per-job register: current
 * assigned crew ∩ records, never a false complete. Office can backfill the
 * paper/verbal reality per worker — recorded under its own audit verb so
 * backfills stay distinguishable from self-confirmations.
 */

interface JobInductionCardProps {
  jobId: string;
  inductionRequired: boolean;
  initialCrew: ReadonlyArray<CrewInductionStatus>;
  recordCount: number;
  fetchError: string | null;
}

export function JobInductionCard({
  jobId,
  inductionRequired,
  initialCrew,
  recordCount,
  fetchError,
}: JobInductionCardProps) {
  const router = useRouter();
  const [crew, setCrew] = useState<ReadonlyArray<CrewInductionStatus>>(initialCrew);
  const [backfilling, setBackfilling] = useState<CrewInductionStatus | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inducted = crew.filter((c) => c.inducted).length;
  const allDone = crew.length > 0 && inducted === crew.length;

  async function doBackfill() {
    if (!backfilling) return;
    setBusy(true);
    setError(null);
    const res = await recordInductionFor(jobId, backfilling.workerId, note.trim() || undefined);
    setBusy(false);
    setBackfilling(null);
    setNote("");
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    const fresh = await jobInductions(jobId);
    if (fresh.ok) setCrew(fresh.data.crew);
    router.refresh();
  }

  return (
    <Card role="region" aria-label="Site induction">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="h-5 w-5 text-brand-navy" />
          <div>
            <CardTitle>Site induction</CardTitle>
            <CardDescription className="mt-0.5">
              {inductionRequired
                ? "Required on this job — workers confirm in Phil; record paper/verbal inductions here."
                : "No longer flagged as required — past records are kept below."}
            </CardDescription>
          </div>
        </div>
        {crew.length > 0 ? (
          <Pill tone={allDone ? "success" : "warning"}>
            {inducted}/{crew.length} inducted
          </Pill>
        ) : null}
      </div>

      {fetchError ? (
        <p className="mt-2 text-sm text-text-muted">{fetchError}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {crew.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No crew assigned yet{recordCount > 0 ? ` — ${recordCount} past ${recordCount === 1 ? "record" : "records"} kept on file` : ""}.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {crew.map((c) => (
            <li key={c.workerId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-text">{c.workerName}</span>
                {c.inducted ? (
                  <span className="text-text-muted">
                    {" "}
                    · {formatDay(c.completedAt)}
                    {c.backfill ? ` · recorded by ${c.recordedByName ?? "the office"}` : ""}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Pill tone={c.inducted ? "success" : "warning"}>
                  {c.inducted ? "Inducted" : "Not yet"}
                </Pill>
                {!c.inducted ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setBackfilling(c)}
                    data-testid="induction-backfill-open"
                  >
                    Record
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(backfilling)}
        onClose={() => setBackfilling(null)}
        title={`Record induction for ${backfilling?.workerName ?? ""}?`}
      >
        <p className="text-sm text-text-muted">
          Use this for inductions done on paper or verbally — the record keeps
          you as the recorder, distinct from the worker confirming in Phil.
        </p>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional — e.g. paper form, 12 Jun)"
          className="mt-3 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
          data-testid="induction-backfill-note"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setBackfilling(null)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={doBackfill} disabled={busy} data-testid="induction-backfill-confirm">
            Record induction
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

function formatDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
