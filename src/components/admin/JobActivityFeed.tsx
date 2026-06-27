"use client";

import { useMemo, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import {
  groupLabel,
  summariseJobActivity,
  targetGroup,
  type AuditTargetGroup,
} from "@/domains/audit-log/format";
import { sortNewestFirst } from "@/domains/audit-log/client";
import type { AuditLogEntry } from "@/domains/audit-log/types";
import { ActivityRow } from "./ActivityRow";

interface Props {
  initialEntries: ReadonlyArray<AuditLogEntry>;
  fetchError: string | null;
  /** Render-time job context, only used for the heading copy. */
  jobName: string;
}

const ALL_GROUPS: ReadonlyArray<AuditTargetGroup> = [
  "evidence",
  "snag",
  "observation",
  "material_request",
  "itp",
];

/**
 * Per-job activity feed (PR 9). Surfaces the operational memory the audit-log
 * has been recording all along — every evidence capture/review, snag raise/
 * transition, ITP attach/record/signoff, and observation→snag conversion on
 * THIS job, in one chronological list.
 *
 * Exception-first is the wrong shape here (every event matters in a timeline,
 * not just open ones), so the only sort dimension is recency. Filter chips
 * narrow by surface so an admin can ask "what evidence work happened today"
 * or "what snag transitions did the LH make this week."
 *
 * The feed is read-only (the audit-log itself is append-only at the API).
 */
export function JobActivityFeed({ initialEntries, fetchError, jobName }: Props) {
  const [active, setActive] = useState<AuditTargetGroup | null>(null);

  const sortedAll = useMemo(() => sortNewestFirst(initialEntries), [initialEntries]);
  const summary = useMemo(() => summariseJobActivity(sortedAll), [sortedAll]);
  const visible = useMemo(() => {
    if (!active) return sortedAll;
    return sortedAll.filter((e) => targetGroup(e.targetType) === active);
  }, [sortedAll, active]);

  return (
    <div className="space-y-5">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the activity feed</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. The list may be incomplete.
          </CardDescription>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Activity on {jobName}</CardTitle>
        <CardDescription>
          Every evidence capture and review, snag and transition, ITP
          milestone, and observation conversion on this job — newest first.
          The audit trail is append-only and the office can&rsquo;t edit it.
        </CardDescription>
      </Card>

      <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-2">
        <Button
          type="button"
          size="sm"
          variant={active === null ? "primary" : "ghost"}
          onClick={() => setActive(null)}
        >
          All <Pill tone={active === null ? "yellow" : "neutral"}>{summary.total}</Pill>
        </Button>
        {ALL_GROUPS.map((g) => {
          const count = summary[g];
          if (count === 0 && active !== g) return null;
          return (
            <Button
              key={g}
              type="button"
              size="sm"
              variant={active === g ? "primary" : "ghost"}
              onClick={() => setActive(active === g ? null : g)}
            >
              {groupLabel(g)}{" "}
              <Pill tone={active === g ? "yellow" : "neutral"}>{count}</Pill>
            </Button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={
            active === null
              ? "Nothing has happened on this job yet"
              : `No ${groupLabel(active).toLowerCase()} activity yet`
          }
          description={
            active === null
              ? "When the field captures evidence, raises a snag, signs an ITP, or the office converts an observation, it lands here."
              : "Switch filters above to see activity from other surfaces."
          }
          action={
            active !== null ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setActive(null)}>
                Show all activity
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ol className="space-y-2" aria-label="Job activity timeline">
          {visible.map((e) => (
            <li key={e.id}>
              <ActivityRow entry={e} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
