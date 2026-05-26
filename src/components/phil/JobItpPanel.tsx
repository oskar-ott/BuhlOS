import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";

/**
 * Phil — Job ITP / QA panel.
 *
 * Job-interface stub. The ITP backend (E1a) shipped in PR #34 — domain,
 * schemas, audit-log integration, independence-rule guard, statsItpsActive.
 * The Phil per-instance recording UI is E1b ([33-phase-e-build-prompts.md] §E1b);
 * the admin queue + sign-off is E1c (§E1c). Until those slices land this
 * section stays UNDER CONSTRUCTION inside PhilJobDetail so workers can see
 * the section exists without being asked to act on something half-built.
 *
 * No live data is read here. When E1b runs, replace this stub with a real
 * panel that lists attached ITP instances + a tap target into
 * /phil/jobs/[jobId]/itps/[instanceId].
 *
 * Cross-ref:
 *   docs/rebuild-audit/32-phase-e-plan.md §6 Phil UI
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1b
 *   docs/rebuild-audit/35-current-product-state-audit.md §12 E1b readiness
 */
export function JobItpPanel() {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>ITP / QA</CardTitle>
          <CardDescription className="mt-1">
            Inspection &amp; test plans for this job. Tick each point as you
            go &mdash; photo, value, sign-off, or note.
          </CardDescription>
        </div>
        <Pill tone="neutral">UC</Pill>
      </div>
      <div className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
        <p>
          <span className="font-semibold text-text">Under construction.</span>{" "}
          The recording flow is being built next. The backend (templates,
          attach, record, sign-off) is ready &mdash; the worker recording UI
          drops in here when E1b ships.
        </p>
        <p className="mt-2">
          For now, keep using the legacy{" "}
          <a
            href="/admin/itp"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ITP page on the office app
          </a>{" "}
          for any attaches your PM needs to make. Field recording lands here.
        </p>
      </div>
    </Card>
  );
}
