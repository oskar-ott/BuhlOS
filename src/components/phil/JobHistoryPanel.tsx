import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";

/**
 * Phil &mdash; Job history panel.
 *
 * Job-interface stub. The V2 audit-log already records every evidence,
 * snag, and ITP event cross-job (see
 * [api/_lib/audit-log.js](../../../api/_lib/audit-log.js) and the per-drawer
 * History panels in `EvidenceDrawer.tsx`, `SnagDrawer.tsx`). A consolidated
 * job-level history view that aggregates across all surfaces is a later
 * slice &mdash; it depends on E1b/E1c (so the ITP rows actually have
 * worker-visible meaning) and on a worker-friendly summary helper. Until
 * then this section stays UNDER CONSTRUCTION.
 *
 * Cross-ref:
 *   src/components/admin/SnagDrawer.tsx &mdash; admin-side history precedent
 *   docs/rebuild-audit/35-current-product-state-audit.md §13 PR plan
 */
export function JobHistoryPanel() {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>History</CardTitle>
          <CardDescription className="mt-1">
            Recent activity on this job &mdash; captures, snags and sign-offs.
          </CardDescription>
        </div>
        <Pill tone="neutral">UC</Pill>
      </div>
      <div className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
        <p>
          <span className="font-semibold text-text">Under construction.</span>{" "}
          A worker-friendly job history feed lands here once the ITP surfaces
          land too. Per-item history is already visible to admins through
          each drawer&rsquo;s History panel.
        </p>
      </div>
    </Card>
  );
}
