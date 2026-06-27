import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import type { JobStatus } from "@/domains/jobs/types";

// Bridge the jobs-domain tone vocabulary onto the shared StatusChip palette —
// kept in sync with PhilJobsList's JOBS_CHIP_TONE.
const JOBS_CHIP_TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

/** The lightweight job identity the shell shows above the fold — exactly the
 *  field-redacted summary fields (no structure, no money). */
export interface JobShellHeader {
  id: string;
  name: string;
  status: JobStatus | undefined;
  ref?: string | null;
  siteAddress?: string | null;
  typeName?: string | null;
}

/**
 * Above-the-fold job-detail SHELL, rendered as the <Suspense> fallback for
 * /phil/jobs/[jobId] while the full job structure + panels stream in below.
 *
 * It paints a USEFUL header — job name, status, ref, site, type — sourced from
 * the cheap jobs-summary projection (the same data /phil/jobs lists), so a worker
 * who taps a job sees what they opened in ~1s instead of staring at a generic
 * skeleton for ~5s. Honest: the body is an explicit "Loading job details…"
 * placeholder (no fabricated tasks/proof/counts); when the real PhilJobDetail
 * resolves it replaces this whole shell. When `header` is null (the job isn't in
 * the worker's visible list) only the back link + a neutral skeleton show, and
 * the streamed full read resolves to the authoritative not-found/forbidden view.
 */
export function PhilJobDetailShell({ header }: { header: JobShellHeader | null }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <PhilBackLink href="/phil/jobs">All jobs</PhilBackLink>

      {header ? (
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-5">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 text-lg font-semibold text-text">{header.name}</h1>
            <StatusChip tone={JOBS_CHIP_TONE[statusTone(header.status)]}>
              {statusLabel(header.status)}
            </StatusChip>
          </div>
          {header.siteAddress?.trim() ? (
            <p className="text-sm text-text-muted">{header.siteAddress.trim()}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
            {header.ref ? <span>Ref {header.ref}</span> : null}
            {header.typeName ? <span>{header.typeName}</span> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-5">
          <PhilSkeleton className="h-6 w-2/3" />
          <PhilSkeleton className="h-4 w-1/2" />
        </div>
      )}

      <p className="px-1 text-sm text-text-muted">Loading job details…</p>
      <PhilSkeletonCard />
      <PhilSkeletonCard />
    </div>
  );
}
