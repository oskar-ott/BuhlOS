import { MapPin } from "lucide-react";
import { Card, CardDescription } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { statusLabel, statusTone, type JobStatusTone } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";

const STATUS_PILL_TONE: Record<JobStatusTone, "success" | "warning" | "neutral"> = {
  success: "success",
  warning: "warning",
  neutral: "neutral",
};

interface Props {
  job: Job;
}

/**
 * Phil — Job hero card.
 *
 * The "command view" header for an individual job, per the Phil Job
 * Interface Bible §08: in two seconds the worker should know which job
 * they're in, what state it's in, and where the site is. Sits at the
 * very top of /phil/jobs/[jobId] above the attention strip and section
 * sections.
 *
 * Rules from the bible (§13 field rules):
 *   - Job name is the loudest thing. No icons next to it.
 *   - Status pill is the only badge here — at most two more lines.
 *   - Address line truncates; tap-to-call lives on the Site card lower
 *     on the page, not here.
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §08
 *   src/components/phil/PhilJobDetail.tsx — caller
 */
export function PhilJobHero({ job }: Props) {
  const meta = [job.ref ? `Ref ${job.ref}` : null, job.typeName]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="border-brand-navy/15">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words font-display text-xl font-semibold leading-tight text-text">
            {job.name}
          </h2>
          {meta ? (
            <CardDescription className="mt-1">{meta}</CardDescription>
          ) : null}
        </div>
        <Pill
          tone={STATUS_PILL_TONE[statusTone(job.status)]}
          className="shrink-0"
        >
          {statusLabel(job.status)}
        </Pill>
      </div>
      {job.siteAddress ? (
        <div className="mt-3 flex items-center gap-1.5 text-sm text-text-muted">
          <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate" title={job.siteAddress}>
            {job.siteAddress}
          </span>
        </div>
      ) : null}
    </Card>
  );
}
