import Link from "next/link";
import type { Route } from "next";
import {
  AlertOctagon,
  Camera,
  ChevronRight,
  ClipboardCheck,
  FileText,
  History,
  Inbox,
  Package,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
}

type SectionRow =
  | {
      kind: "live";
      label: string;
      description: string;
      href: Route;
      count?: number;
      icon: typeof Camera;
    }
  | {
      kind: "uc";
      label: string;
      description: string;
      icon: typeof Camera;
      ucReason: string;
    };

/**
 * Admin job interface section nav.
 *
 * Sits inside /v2/jobs/[jobId] (the job hub) and exposes every section
 * we want to surface for a job &mdash; live ones link to the rebuild
 * surface for that section; UC ones surface a short explanation of why
 * it isn't wired yet. The hub itself owns Overview and Site (rendered
 * above this nav in the page); this list is the rest.
 *
 * Counts come from job.statsEvidenceV2Pending / statsSnagsV2Active /
 * statsItpsActive on the Job object, the same enrichment the D6 jobs
 * index uses. When the count is `undefined` we omit the chip rather than
 * fabricate a zero &mdash; the cell renders without it.
 *
 * Section order mirrors PhilJobDetail's vertical layout precedent
 * (per doc 34 §B.2): Evidence &middot; Snags &middot; ITPs &middot;
 * Documents &middot; Materials &middot; History. Overview + Site live
 * above this in the hub page itself.
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
      kind: "live",
      label: "Snags",
      description: "Defects raised by the field, admin transitions and rejection reasons.",
      href: `/v2/jobs/${jobIdEnc}/snags` as Route,
      count: job.statsSnagsV2Active,
      icon: AlertOctagon,
    },
    {
      kind: "live",
      label: "Observations",
      description:
        "Field-to-office notes, blockers, plan mismatches, material requests, RFIs and instructions raised against this job.",
      href: `/v2/jobs/${jobIdEnc}/observations` as Route,
      icon: Inbox,
    },
    {
      kind: "live",
      label: "ITP / QA",
      description:
        "Attached inspection / test plans, field results, admin sign-off.",
      href: `/v2/jobs/${jobIdEnc}/itps` as Route,
      count: job.statsItpsActive,
      icon: ClipboardCheck,
    },
    {
      kind: "live",
      label: "Documents & specs",
      description: "Plans, schedules, install specs, supplier docs.",
      href: `/v2/jobs/${jobIdEnc}/documents` as Route,
      count: job.statsDocumentsCurrent,
      icon: FileText,
    },
    {
      kind: "uc",
      label: "Materials",
      description: "Job materials list, requests, supplied / used status.",
      icon: Package,
      ucReason:
        "Real materials data lives on the legacy /admin/materials surface (takeoff + PO + invoice match). A scoped worker view is deferred to a later slice.",
    },
    {
      kind: "uc",
      label: "History",
      description: "Consolidated audit trail across every section on this job.",
      icon: History,
      ucReason:
        "Per-item history already lives in each drawer (evidence, snag, future ITP). A job-level consolidated feed is scoped for after E1b/E1c.",
    },
  ];

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle>Sections</CardTitle>
          <CardDescription className="mt-1">
            Every part of the job interface in one place. Live sections open
            their queue. UC sections show what&rsquo;s coming.
          </CardDescription>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {rows.map((row) => (
          <li key={row.label}>
            {row.kind === "live" ? (
              <LiveRow row={row} />
            ) : (
              <UcRow row={row} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LiveRow({ row }: { row: Extract<SectionRow, { kind: "live" }> }) {
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

function UcRow({ row }: { row: Extract<SectionRow, { kind: "uc" }> }) {
  const Icon = row.icon;
  return (
    <div
      className="flex min-h-[64px] items-start gap-3 px-4 py-3"
      aria-label={`${row.label} — under construction`}
    >
      <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-display text-base font-semibold text-text-muted">
            {row.label}
          </span>
          <Pill tone="neutral" className="text-[10px] uppercase tracking-wider">
            UC
          </Pill>
        </span>
        <span className="mt-0.5 block text-xs text-text-muted">{row.description}</span>
        <span className="mt-1 block text-xs text-text-muted/80">{row.ucReason}</span>
      </span>
    </div>
  );
}
