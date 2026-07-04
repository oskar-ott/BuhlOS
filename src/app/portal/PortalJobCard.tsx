import Link from "next/link";
import type { Route } from "next";
import { MapPin, ChevronRight } from "lucide-react";
import type { PortalJob } from "@/domains/client-portal/schema";
import { PortalProgress } from "./PortalProgress";

/**
 * A single job on the portal home list — a tappable card linking to the job's
 * sanitised overview. Renders ONLY the allowlist fields (name, site address,
 * progress); nothing internal.
 */
export function PortalJobCard({ job }: { job: PortalJob }) {
  return (
    <Link
      href={`/portal/jobs/${job.id}` as Route}
      className="block rounded-card border border-border bg-surface-raised p-5 shadow-card transition hover:border-brand-navy/40 active:scale-[0.995]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg text-text">{job.name}</h2>
          {job.siteAddress ? (
            <p className="mt-0.5 flex items-center gap-1 text-sm text-text-muted">
              <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{job.siteAddress}</span>
            </p>
          ) : null}
        </div>
        <ChevronRight aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-text-muted" />
      </div>
      <div className="mt-4">
        <PortalProgress progressPct={job.progressPct} stageLabel={job.stageLabel} />
      </div>
    </Link>
  );
}
