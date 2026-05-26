import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";

/**
 * Phil — Job documents / specs panel.
 *
 * Job-interface stub. Real plan + document data lives on the legacy
 * /admin/plans surface via [api/plans.js](../../../api/plans.js) (the Phase 9
 * AI-takeoff pipeline), and quote documents live at
 * [api/quote-documents.js](../../../api/quote-documents.js). Wiring a
 * worker-facing read-only document list (file name + type + open link) is
 * scoped to a later "E2 · Documents / Spec access" slice once the legacy
 * shape is audited end-to-end. Until then this section stays UNDER
 * CONSTRUCTION so the worker sees the section exists without false buttons.
 *
 * No live data is read here. The future slice will:
 *   - GET /api/plans?jobId=X for the plan register
 *   - Render a worker-safe subset (no upload, no AI-takeoff actions)
 *   - Open-in-new-tab to the plan blob URL
 *
 * Cross-ref:
 *   docs/rebuild-audit/35-current-product-state-audit.md §13 PR plan
 */
export function JobDocumentsPanel() {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Documents &amp; specs</CardTitle>
          <CardDescription className="mt-1">
            Plans, schedules and specs for this job &mdash; in one place.
          </CardDescription>
        </div>
        <Pill tone="neutral">UC</Pill>
      </div>
      <div className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
        <p>
          <span className="font-semibold text-text">Under construction.</span>{" "}
          A worker-facing document and spec viewer lands here once the legacy
          plan register is wrapped. No fake file list, no half-working preview
          until that work is ready.
        </p>
        <p className="mt-2">
          For now, plans and specs live on the office app under{" "}
          <a
            href="/admin/plans"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Plans
          </a>
          . Ask your leading hand to send the file you need.
        </p>
      </div>
    </Card>
  );
}
