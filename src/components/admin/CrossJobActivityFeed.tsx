"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { sortNewestFirst } from "@/domains/audit-log/client";
import { groupLabel, targetGroup, type AuditTargetGroup } from "@/domains/audit-log/format";
import type { AuditLogEntry } from "@/domains/audit-log/types";
import { ActivityRow } from "./ActivityRow";
import { cn } from "@/lib/cn";

/**
 * Company-wide activity feed (#220) — one chronological, day-grouped view of
 * what happened across ALL jobs, filterable by surface / job / actor (all
 * URL-driven). Reuses the shared ActivityRow (not a parallel renderer). Read-only
 * over the same monthly audit blobs; the server bounds the read.
 */

const GROUPS: ReadonlyArray<AuditTargetGroup> = ["evidence", "snag", "observation", "material_request", "itp"];

interface Props {
  entries: ReadonlyArray<AuditLogEntry>;
  jobNameById: Record<string, string>;
  fetchError: string | null;
}

export function CrossJobActivityFeed({ entries, jobNameById, fetchError }: Props) {
  const pathname = usePathname();
  const params = useSearchParams();
  const typeGroup = params.get("group") as AuditTargetGroup | null;
  const jobFilter = params.get("job");
  const actorFilter = params.get("actor");

  const sorted = useMemo(() => sortNewestFirst(entries), [entries]);

  // Distinct actors/jobs present, for the filter selects.
  const actors = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of sorted) if (e.actorId) m.set(e.actorId, e.actorName || e.actorId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sorted]);
  const jobs = useMemo(() => {
    const ids = new Set<string>();
    for (const e of sorted) if (e.jobId) ids.add(e.jobId);
    return [...ids].map((id) => [id, jobNameById[id] || id] as const).sort((a, b) => a[1].localeCompare(b[1]));
  }, [sorted, jobNameById]);

  const visible = useMemo(
    () =>
      sorted.filter(
        (e) =>
          (typeGroup ? targetGroup(e.targetType) === typeGroup : true) &&
          (jobFilter ? e.jobId === jobFilter : true) &&
          (actorFilter ? e.actorId === actorFilter : true)
      ),
    [sorted, typeGroup, jobFilter, actorFilter]
  );

  // Group visible entries by calendar day (from ts), newest day first.
  const byDay = useMemo(() => {
    const groups: Array<{ day: string; items: AuditLogEntry[] }> = [];
    let cur: { day: string; items: AuditLogEntry[] } | null = null;
    for (const e of visible) {
      const day = String(e.ts || "").slice(0, 10);
      if (!cur || cur.day !== day) {
        cur = { day, items: [] };
        groups.push(cur);
      }
      cur.items.push(e);
    }
    return groups;
  }, [visible]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      /* history throttled */
    }
  }

  const selectClass = "h-8 rounded-card border border-border bg-surface px-2 text-xs";

  return (
    <div className="space-y-4">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the activity feed</CardTitle>
          <CardDescription className="text-amber-900">{fetchError}. The list may be incomplete.</CardDescription>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Activity across all jobs</CardTitle>
        <CardDescription>
          What the crew and office did, newest first. The audit trail is append-only — this is a read-only review.
        </CardDescription>
      </Card>

      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-2">
        <button
          type="button"
          onClick={() => setParam("group", null)}
          aria-pressed={!typeGroup}
          className={cn("rounded-pill border px-2.5 py-1 text-xs font-medium", !typeGroup ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text")}
        >
          All
        </button>
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setParam("group", typeGroup === g ? null : g)}
            aria-pressed={typeGroup === g}
            className={cn("rounded-pill border px-2.5 py-1 text-xs font-medium", typeGroup === g ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text")}
          >
            {groupLabel(g)}
          </button>
        ))}
        <select aria-label="Filter by job" className={selectClass} value={jobFilter ?? ""} onChange={(e) => setParam("job", e.target.value || null)}>
          <option value="">All jobs</option>
          {jobs.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select aria-label="Filter by person" className={selectClass} value={actorFilter ?? ""} onChange={(e) => setParam("actor", e.target.value || null)}>
          <option value="">Everyone</option>
          {actors.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No activity in this window"
          description="As the crew capture evidence, raise snags, sign ITPs and the office reviews, it lands here. Widen the date window or clear filters."
        />
      ) : (
        <div className="space-y-5">
          {byDay.map((grp) => (
            <section key={grp.day} aria-label={`Activity on ${grp.day}`}>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
                {grp.day || "Undated"} · {grp.items.length}
              </h3>
              <ol className="space-y-2">
                {grp.items.map((e) => (
                  <li key={e.id}>
                    <ActivityRow entry={e} jobLabel={e.jobId ? jobNameById[e.jobId] || e.jobId : null} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {visible.length > 0 ? (
        <p className="text-center text-xs text-text-muted">
          Showing {visible.length} {visible.length === 1 ? "event" : "events"} · <Pill tone="neutral">read-only</Pill>
        </p>
      ) : null}
    </div>
  );
}
