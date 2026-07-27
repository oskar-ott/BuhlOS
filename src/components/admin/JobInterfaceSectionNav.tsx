import Link from "next/link";
import type { Route } from "next";
import { Camera, ChevronRight, Images } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
}

type SectionRow = {
  kind: "live";
  label: string;
  description: string;
  href: Route;
  count?: number;
  icon: typeof Camera;
};

/**
 * Admin job interface section nav.
 *
 * Sits inside /v2/jobs/[jobId] (the job hub) and exposes every section
 * we want to surface for a job &mdash; each links to the rebuild surface
 * for that section. The hub itself owns Overview and Site (rendered above
 * this nav in the page); this list is the rest.
 *
 * The Evidence count comes from job.statsEvidenceV2Pending on the Job object,
 * the same enrichment the D6 jobs index uses. When the count is `undefined` we
 * omit the chip rather than fabricate a zero &mdash; the cell renders without it.
 *
 * Section order: Evidence &middot; Photos. Overview + Site live above this in
 * the hub page itself. The 2026-07-27 gut (docs/product/02-lean-reset.md)
 * deleted every other section with its feature — every row is a live link.
 *
 * Cross-ref:
 *   src/components/admin/JobsList.tsx &mdash; row chip pattern (these
 *       cards intentionally mirror the chips, just at hub-level instead
 *       of index-level)
 *   docs/rebuild-audit/35-current-product-state-audit.md §7.2 Admin
 */
export function JobInterfaceSectionNav({ job }: Props) {
  const jobIdEnc = encodeURIComponent(job.id);

  const rows: ReadonlyArray<SectionRow> = [
    {
      kind: "live",
      label: "Evidence",
      description: "Photo / note captures, admin review, history.",
      href: `/v2/jobs/${jobIdEnc}/evidence` as Route,
      count: job.statsEvidenceV2Pending,
      icon: Camera,
    },
    {
      // #242: read-only photo gallery (the "Job Bible") — browse every photo on
      // the job (field captures + snag + ITP / dwelling) date-grouped and
      // filterable. Distinct from Evidence above, which is the review queue.
      // No count: a total would need an extra fetch the hub doesn't do, so we
      // omit the chip rather than fabricate one (P7 / the count convention).
      kind: "live",
      label: "Photos",
      description:
        "Browse every photo on this job — field captures, snag photos and ITP / dwelling photos, date-grouped and filterable. Read-only.",
      href: `/v2/jobs/${jobIdEnc}/photos` as Route,
      icon: Images,
    },
  ];

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle>Sections</CardTitle>
          <CardDescription className="mt-1">
            Every part of the job interface in one place. Each section opens
            its queue.
          </CardDescription>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {rows.map((row) => (
          <li key={row.label}>
            <LiveRow row={row} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LiveRow({ row }: { row: SectionRow }) {
  const Icon = row.icon;
  const hasCount = typeof row.count === "number";
  const highlightCount = hasCount && row.count! > 0;
  return (
    <Link
      href={row.href}
      className="flex min-h-[64px] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
      aria-label={`Open ${row.label} for this job`}
    >
      <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block font-display text-base font-semibold text-text">
          {row.label}
        </span>
        <span className="block text-xs text-text-muted">{row.description}</span>
      </span>
      {hasCount ? (
        <Pill
          tone={highlightCount ? "navy" : "neutral"}
          className={cn(
            "shrink-0",
            highlightCount ? "font-semibold" : "text-text-muted"
          )}
        >
          {row.count}
        </Pill>
      ) : null}
      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
    </Link>
  );
}
