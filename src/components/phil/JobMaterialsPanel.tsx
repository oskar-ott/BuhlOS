import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";

/**
 * Phil — Job materials panel.
 *
 * Job-interface stub. Real materials data lives on
 * [api/materials-list.js](../../../api/materials-list.js) &mdash; a 1,200+ line
 * Phase 10/11/12 surface covering takeoff, purchase orders, supplier
 * 3-way invoice match, and per-item status. Building a worker-facing
 * materials request UI is scoped to a separate "E3 · Materials request"
 * slice (or later E4 materials rebuild) once the wholesaler / PO / invoice
 * concerns are scoped. Until then this section stays UNDER CONSTRUCTION
 * so the worker sees the section exists without us faking stock numbers or
 * approvals that aren't wired.
 *
 * No live data is read here. The future slice will scope to:
 *   - Read-only worker view: required / requested / supplied / used
 *   - A request-this-material flow if (and only if) the existing API
 *     already supports a worker-side write
 *   - No PO / invoice / variance / supplier UI in Phil
 *
 * Cross-ref:
 *   docs/rebuild-audit/35-current-product-state-audit.md §13 PR plan
 *   docs/rebuild-audit/32-phase-e-plan.md §2.2 (materials deferred to E4+)
 */
export function JobMaterialsPanel() {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Materials</CardTitle>
          <CardDescription className="mt-1">
            What&rsquo;s needed, what&rsquo;s ordered, what&rsquo;s arrived
            &mdash; for this job.
          </CardDescription>
        </div>
        <Pill tone="neutral">UC</Pill>
      </div>
      <div className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
        <p>
          <span className="font-semibold text-text">Under construction.</span>{" "}
          The job materials list and worker-facing requests land here in a
          later slice. We&rsquo;re keeping it off until the worker-side
          actions are real &mdash; no fake stock counts, no half-working
          request buttons.
        </p>
        <p className="mt-2">
          For now, materials live on the office app under{" "}
          <a
            href="/admin/materials"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Materials
          </a>
          . Stick with the current office process &mdash; phone or text your
          PM if you need something.
        </p>
      </div>
    </Card>
  );
}
