import Link from "next/link";
import type { Route } from "next";
import {
  AlertOctagon,
  Camera,
  ChevronRight,
  ClipboardCheck,
  FileText,
  History,
  Images,
  Inbox,
  ListChecks,
  Map as MapIcon,
  NotebookPen,
  Package,
  PackageCheck,
  Scale,
  ScrollText,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { moduleEnabled } from "@/domains/jobs/builder";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  job: Job;
  /** #219: show the Safety documents row. Flag-gated (safety_docs) by the hub. */
  safetyEnabled?: boolean;
  /** #231: show the Certificates register row. Flag-gated (certificates_register) by the hub. */
  certificatesEnabled?: boolean;
  /** #276: show the RFIs register row. Flag-gated (rfi_register) by the hub. */
  rfiEnabled?: boolean;
  /** #217: show the Minutes register row. Flag-gated (minutes_register) by the hub. */
  minutesEnabled?: boolean;
  /** #760: ITPs are a kill-switch feature — hide the ITP / QA row when off. */
  itpEnabled?: boolean;
  /**
   * #760 owner feature-control: resolved kill-switch state for the rest of the
   * job sections, keyed by flag (evidence, job_photos, snags, …). A row tagged
   * with a `flag` is HIDDEN only when its entry is explicitly `false` — i.e.
   * shown by default (these are live features), hidden when the owner turns it
   * off. The hub page resolves every key, so "off" always reaches here.
   */
  killSwitches?: Partial<Record<string, boolean>>;
}

type SectionRow =
  | {
      kind: "live";
      label: string;
      description: string;
      href: Route;
      count?: number;
      icon: typeof Camera;
      /** #760: the kill-switch flag gating this row (via `killSwitches`). */
      flag?: string;
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
 * Section order: Evidence &middot; Snags &middot; Observations (PR 8) &middot;
 * ITPs &middot; Documents &middot; Materials (UC) &middot; Activity (LIVE, PR 9).
 * PR 9 flipped Activity (was "History") from UC to LIVE — it now points at
 * /v2/jobs/[jobId]/history which consumes the audit-log via the
 * scope=job mode.
 * Documents &middot; Materials &middot; History. Overview + Site live
 * above this in the hub page itself.
 *
 * Cross-ref:
 *   src/components/admin/JobsList.tsx &mdash; row chip pattern (these
 *       cards intentionally mirror the chips, just at hub-level instead
 *       of index-level)
 *   docs/rebuild-audit/35-current-product-state-audit.md §7.2 Admin
 */
export function JobInterfaceSectionNav({
  job,
  safetyEnabled = false,
  certificatesEnabled = false,
  rfiEnabled = false,
  minutesEnabled = false,
  itpEnabled = false,
  killSwitches,
}: Props) {
  const jobIdEnc = encodeURIComponent(job.id);

  const rows: ReadonlyArray<SectionRow> = [
    {
      kind: "live",
      label: "Evidence",
      description: "Photo / note captures, admin review, history.",
      href: `/v2/jobs/${jobIdEnc}/evidence` as Route,
      count: job.statsEvidenceV2Pending,
      icon: Camera,
      flag: "evidence",
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
      flag: "job_photos",
    },
    {
      kind: "live",
      label: "Snags",
      description: "Defects raised by the field, admin transitions and rejection reasons.",
      href: `/v2/jobs/${jobIdEnc}/snags` as Route,
      count: job.statsSnagsV2Active,
      icon: AlertOctagon,
      flag: "snags",
    },
    {
      kind: "live",
      label: "Observations",
      description:
        "Field-to-office notes, blockers, plan mismatches, material requests, RFIs and instructions raised against this job.",
      href: `/v2/jobs/${jobIdEnc}/observations` as Route,
      icon: Inbox,
      flag: "observations_inbox",
    },
    ...(itpEnabled
      ? [
          {
            kind: "live",
            label: "ITP / QA",
            description:
              "Attached inspection / test plans, field results, admin sign-off.",
            href: `/v2/jobs/${jobIdEnc}/itps` as Route,
            count: job.statsItpsActive,
            icon: ClipboardCheck,
          } satisfies SectionRow,
        ]
      : []),
    {
      kind: "live",
      label: "Scope reconciliation",
      description:
        "Scope-vs-quote review: the confirmed classification of every clause and the open conflicts (excluded-but-owed, by-others, alternates) before work starts.",
      href: `/v2/jobs/${jobIdEnc}/scope` as Route,
      icon: Scale,
      flag: "scope_reconciliation",
    },
    {
      kind: "live",
      label: "Job control",
      description:
        "Author required proof: tie a scope clause to a worker task, set the proof the field must capture, and compile it for Phil.",
      href: `/v2/jobs/${jobIdEnc}/job-control` as Route,
      icon: ListChecks,
      flag: "job_control",
    },
    {
      // #374: closeout matrix — handover obligations (test results, certificate
      // of electrical safety, as-builts, the job's closeout clauses), each
      // discharged by links to real records + an admin confirm, with honest
      // N-of-M readiness. Read-only on completion (doesn't gate close-out).
      kind: "live",
      label: "Closeout",
      description:
        "Handover obligations — test results, certificate of electrical safety, as-builts and the job's closeout clauses. Closed out only when a real record resolves and an admin confirms.",
      href: `/v2/jobs/${jobIdEnc}/closeout` as Route,
      icon: PackageCheck,
      flag: "closeout",
    },
    {
      kind: "live",
      label: "Documents & specs",
      description: "Plans, schedules, install specs, supplier docs.",
      href: `/v2/jobs/${jobIdEnc}/documents` as Route,
      count: job.statsDocumentsCurrent,
      icon: FileText,
      flag: "documents",
    },
    {
      kind: "live",
      label: "Circuit schedules",
      description:
        "Distribution-board circuit schedules — device, cable, load and live voltage-drop / phase-balance / capacity checks (AS/NZS 3000), print to PDF.",
      href: `/v2/jobs/${jobIdEnc}/circuit-schedule` as Route,
      icon: Zap,
      flag: "circuit_schedule",
    },
    // Plans viewer — the in-app raster drawing viewer (read-only Phase 1),
    // distinct from the Documents register above. Gated on the job's
    // `plans` module flag (defaults true server-side) so a job that
    // disables plans doesn't advertise it.
    ...(moduleEnabled(job, "plans")
      ? [
          {
            kind: "live",
            label: "Plans",
            description:
              "Open drawings in the in-app viewer — zoom, rotate and page through current (and superseded) revisions.",
            href: `/v2/jobs/${jobIdEnc}/plans` as Route,
            icon: MapIcon,
          } satisfies SectionRow,
        ]
      : []),
    // #219: Safety documents (SWMS/SDS) + acknowledge-read in Phil. Flag-gated
    // by the hub (safety_docs); dark until on.
    ...(safetyEnabled
      ? [
          {
            kind: "live",
            label: "Safety",
            description:
              "SWMS, SDS and site-safety docs. Workers acknowledge they've read each in Phil; see who has and hasn't.",
            href: `/v2/jobs/${jobIdEnc}/safety` as Route,
            icon: ShieldCheck,
          } satisfies SectionRow,
        ]
      : []),
    // #231: Certificates + commissioning register. Flag-gated by the hub
    // (certificates_register); dark until on.
    ...(certificatesEnabled
      ? [
          {
            kind: "live",
            label: "Certificates",
            description:
              "Certificates of compliance, test sheets and commissioning records — typed, with reference + issue date.",
            href: `/v2/jobs/${jobIdEnc}/certificates` as Route,
            icon: FileText,
          } satisfies SectionRow,
        ]
      : []),
    // #276: RFI register — questions to the builder (raise / send / chase / close).
    // Flag-gated by the hub (rfi_register); dark until on.
    ...(rfiEnabled
      ? [
          {
            kind: "live",
            label: "RFIs",
            description:
              "Questions to the builder — raised, sent, chased (overdue surfaces) and answered, on the record.",
            href: `/v2/jobs/${jobIdEnc}/rfis` as Route,
            icon: Inbox,
          } satisfies SectionRow,
        ]
      : []),
    // #217: Meeting-minutes register — date/title/attendees/body or PDF, with
    // stamped append-only amendments. Flag-gated by the hub (minutes_register);
    // dark until on.
    ...(minutesEnabled
      ? [
          {
            kind: "live",
            label: "Minutes",
            description:
              "Meeting minutes — date, title, attendees and the body or a PDF. Append-only, with stamped amendments.",
            href: `/v2/jobs/${jobIdEnc}/minutes` as Route,
            icon: ScrollText,
          } satisfies SectionRow,
        ]
      : []),
    // PR 11: Material Requests live — the field-to-office procurement
    // loop. Separate from legacy /admin/materials (takeoff + PO + invoice
    // match), which still owns structured-PO procurement.
    {
      kind: "live",
      label: "Material requests",
      description:
        "Procurement requests raised against this job — requested / approved / ordered / delivered. Worker raises a Need-material observation in Phil; the office converts it here.",
      href: `/v2/jobs/${jobIdEnc}/material-requests` as Route,
      icon: Package,
      flag: "material_requests",
    },
    {
      kind: "uc",
      label: "Materials (legacy takeoff)",
      description: "Structured materials takeoff, PO and invoice match.",
      icon: Package,
      ucReason:
        "Legacy /admin/materials still owns takeoff + PO + invoice match — a rebuilt scoped view is a later slice. The Material requests row above is the field-to-office request loop (PR 11) and is unrelated.",
    },
    {
      // #210: the job's daily site diary — the office's contemporaneous record
      // (delay-claim evidence). No count chip (like Photos): a total would need
      // an extra fetch the hub doesn't do, so we omit it rather than fabricate.
      kind: "live",
      label: "Diary",
      description:
        "The day-by-day site diary — happenings, weather, attendance and delay flags. The office's contemporaneous record that doubles as delay-claim evidence.",
      href: `/v2/jobs/${jobIdEnc}/diary` as Route,
      icon: NotebookPen,
      flag: "diary",
    },
    {
      kind: "live",
      label: "Activity",
      description:
        "Consolidated audit trail across every section on this job — captures, snag transitions, ITP sign-offs, observation conversions.",
      href: `/v2/jobs/${jobIdEnc}/history` as Route,
      icon: History,
      flag: "job_activity",
    },
  ];

  // #760: hide a live section only when the owner has explicitly turned its
  // kill-switch off. Rows without a `flag` (UC, or gated elsewhere via the
  // existing spread props) always pass this filter.
  const visibleRows = rows.filter(
    (row) => row.kind !== "live" || !row.flag || killSwitches?.[row.flag] !== false,
  );

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
        {visibleRows.map((row) => (
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
