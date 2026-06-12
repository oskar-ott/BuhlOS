import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import type { Job } from "@/domains/jobs/types";

/**
 * Read-only scope of work on the job hub (#200). Admin + LH viewers (the
 * server redaction keeps the field out of every other payload — by the
 * time this renders, having the data IS the permission). Newlines in
 * detail are preserved; the empty state is honest.
 */
export function JobScopeCard({ job }: { job: Job }) {
  const items = (job.scopeOfWork ?? []).slice().sort((a, b) => a.order - b.order);
  return (
    <Card role="region" aria-label="Scope of work">
      <CardTitle>Scope of work</CardTitle>
      <CardDescription className="mt-1">
        The agreed work, as captured in the builder.
      </CardDescription>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No scope captured.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {items.map((item, idx) => (
            <li key={item.id} className="rounded-card border border-border px-3 py-2">
              <p className="text-sm font-medium text-text">
                <span className="font-mono text-xs text-text-muted">{idx + 1}.</span>{" "}
                {item.title}
              </p>
              {item.detail ? (
                <p className="mt-1 whitespace-pre-line text-sm text-text-muted">{item.detail}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
