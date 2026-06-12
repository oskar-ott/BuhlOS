import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { InductionRecord } from "@/domains/jobs/induction";

/**
 * "My site inductions" on the Phil More tab (#332) — the jobs this worker
 * has a recorded induction on (latest per job, newest first). Read-only;
 * confirming happens on the job's own page. Only the worker's OWN records
 * ever reach this card.
 */

interface PhilMyInductionsCardProps {
  records: ReadonlyArray<InductionRecord>;
  fetchError: string | null;
}

export function PhilMyInductionsCard({ records, fetchError }: PhilMyInductionsCardProps) {
  return (
    <Card className="space-y-3">
      <div>
        <CardTitle>My site inductions</CardTitle>
        <CardDescription>
          Jobs where your induction is on record. Confirm new ones on the
          job&rsquo;s page (Site details).
        </CardDescription>
      </div>

      {fetchError ? (
        <p className="text-sm text-text-muted">
          Couldn&rsquo;t load your inductions right now ({fetchError}).
        </p>
      ) : records.length === 0 ? (
        <p className="text-sm text-text-muted">
          None recorded yet. When a job needs an induction you&rsquo;ll see it
          on the job page — one tap there puts it on record.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {records.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text">
                  {r.jobName ?? r.jobId}
                </span>
                <span className="block text-xs text-text-muted">
                  {formatDay(r.completedAt)}
                  {r.backfill ? " · recorded by the office" : ""}
                </span>
              </span>
              <Pill tone="success">Inducted</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
