import Link from "next/link";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import { countTagRegister } from "@/domains/tags/expiry";
import type { TagItem } from "@/domains/tags/schema";

/**
 * Job-page section card for the per-job Test & Tag register (#388) — the
 * standing entry point to /phil/jobs/[jobId]/tags. Mirrors JobItpPanel's
 * shape: heading in plain field language, honest empty state, counts only
 * when real. The command panel's `view_tags` action anchors here when
 * entries need a retest.
 */

interface Props {
  jobId: string;
  initialTags: ReadonlyArray<TagItem>;
  loadError?: boolean;
}

export function JobTagsPanel({ jobId, initialTags, loadError = false }: Props) {
  const counts = countTagRegister(initialTags);
  const href = `/phil/jobs/${encodeURIComponent(jobId)}/tags`;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Test &amp; tag</CardTitle>
          <CardDescription className="mt-1">
            Electrical test &amp; tag register for this job — photograph a sticker to add it.
          </CardDescription>
        </div>
        {counts.expired > 0 ? (
          <Pill tone="danger">{`${counts.expired} expired`}</Pill>
        ) : counts.expiring > 0 ? (
          <Pill tone="warning">{`${counts.expiring} due soon`}</Pill>
        ) : null}
      </div>

      {loadError ? (
        <div className="mt-3">
          <PhilNotice tone="warning" role="status">
            Couldn&rsquo;t load the register. Pull to refresh to try again.
          </PhilNotice>
        </div>
      ) : counts.total === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No tags recorded on this job yet.</p>
      ) : (
        <p className="mt-3 text-sm text-text-muted">
          {counts.total} {counts.total === 1 ? "entry" : "entries"}
          {counts.expired > 0 ? ` · ${counts.expired} expired` : ""}
          {counts.expiring > 0 ? ` · ${counts.expiring} due within 14 days` : ""}
        </p>
      )}

      {!loadError ? (
        <Link
          href={href}
          className="mt-3 inline-block text-sm font-medium text-brand-navy underline underline-offset-2"
          data-testid="open-tag-register"
        >
          Open the register
        </Link>
      ) : null}
    </Card>
  );
}
