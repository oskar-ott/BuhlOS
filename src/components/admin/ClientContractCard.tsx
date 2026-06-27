import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import type { Job } from "@/domains/jobs/types";

/**
 * Read-only client & contract summary on the job hub (#228). Admin tier only:
 * the server redaction (job-redaction.js) keeps clientReference / contractValue
 * / contractNotes out of every non-admin payload, so by the time this renders
 * with the data, having the data IS the permission (the JobScopeCard pattern).
 *
 * The editable home is ClientContractSection in the builder's Basics tab.
 * Honest empty state — no fabricated zero contract value.
 */
function formatContractValue(value: number): string {
  // job.contractValue is stored in dollars (the server ×100s for cents views).
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

export function ClientContractCard({ job }: { job: Job }) {
  const ref = (job.clientReference ?? "").trim() || null;
  const notes = (job.contractNotes ?? "").trim() || null;
  const value =
    typeof job.contractValue === "number" && Number.isFinite(job.contractValue) && job.contractValue >= 0
      ? job.contractValue
      : null;

  const empty = !ref && value === null && !notes;

  return (
    <Card role="region" aria-label="Client and contract">
      <CardTitle>Client &amp; contract</CardTitle>
      <CardDescription className="mt-1">
        Commercial context — office-only, never shown to the field or the client.
      </CardDescription>

      {empty ? (
        <p className="mt-3 text-sm text-text-muted">
          No client or contract details captured. Add them in the builder.
        </p>
      ) : (
        <dl className="mt-3 space-y-3 text-sm">
          {ref ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-text-muted">Client reference</dt>
              <dd className="mt-0.5 text-text">{ref}</dd>
            </div>
          ) : null}
          {value !== null ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-text-muted">Contract value</dt>
              <dd className="mt-0.5 font-medium text-text">{formatContractValue(value)}</dd>
            </div>
          ) : null}
          {notes ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-text-muted">Notes / terms</dt>
              <dd className="mt-0.5 whitespace-pre-line text-text-muted">{notes}</dd>
            </div>
          ) : null}
        </dl>
      )}
    </Card>
  );
}
