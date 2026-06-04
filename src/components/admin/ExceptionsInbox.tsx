"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, AlertTriangle, Search } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import { filterExceptions, isActionable, jobOptions } from "@/domains/exceptions/service";
import {
  getExceptionCounts,
  groupExceptionsByJob,
  groupExceptionsBySource,
} from "@/domains/exceptions/grouping";
import {
  SEVERITY_LABEL,
  SEVERITY_TONE,
  SOURCE_LABEL,
  SOURCE_TONE,
} from "@/domains/exceptions/labels";
import type {
  ActionAvailability,
  ExceptionItem,
  ExceptionSeverity,
  ExceptionSource,
} from "@/domains/exceptions/types";

/**
 * "Needs Attention" — the operational Exceptions Inbox on the Command Centre.
 *
 * A deterministic PROJECTION (built server-side from already-loaded, admin-gated
 * sources) rendered as an actionable inbox: a summary header, view tabs
 * (All / Needs action / Waiting / By job / By source), severity/job/text
 * filters, and rows that say what · which job · why · the next action (a
 * canonical internal link, or an honest muted state — never a broken link).
 * Stores nothing; exposes no raw records. Field/client never reach this surface
 * (the Command Centre page is admin-gated).
 */

const SEVERITIES: ExceptionSeverity[] = ["critical", "warning", "info"];

const TABS = [
  { key: "all", label: "All" },
  { key: "action", label: "Needs action" },
  { key: "waiting", label: "Waiting" },
  { key: "by-job", label: "By job" },
  { key: "by-source", label: "By source" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface Props {
  initialItems: ReadonlyArray<ExceptionItem>;
  /** True when one or more source loads failed (list may be incomplete). */
  partial?: boolean;
  /** Optional initial source filter for server-rendered selected states. */
  initialSource?: ExceptionSource | "all";
}

export function ExceptionsInbox({ initialItems, partial = false, initialSource = "all" }: Props) {
  const [tab, setTab] = useState<TabKey>("all");
  const [source, setSource] = useState<ExceptionSource | "all">(initialSource);
  const [severity, setSeverity] = useState<ExceptionSeverity | "all">("all");
  const [jobId, setJobId] = useState<string>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => getExceptionCounts(initialItems), [initialItems]);
  const jobs = useMemo(() => jobOptions(initialItems), [initialItems]);
  const sourcesPresent = useMemo(
    () =>
      [...new Set(initialItems.map((i) => i.source))].sort((a, b) =>
        (SOURCE_LABEL[a] ?? a).localeCompare(SOURCE_LABEL[b] ?? b)
      ),
    [initialItems]
  );

  const availability: ActionAvailability =
    tab === "action" ? "actionable" : tab === "waiting" ? "waiting" : "all";
  const grouped = tab === "by-job" || tab === "by-source";

  const filtered = useMemo(
    () => filterExceptions(initialItems, { source, severity, jobId, query, availability }),
    [initialItems, source, severity, jobId, query, availability]
  );

  return (
    <Card className="space-y-4" data-testid="exceptions-inbox">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription className="mt-1" data-testid="exceptions-summary">
            {counts.total === 0
              ? "Item-by-item view of what the office needs to action."
              : `${counts.total} open · ${counts.bySeverity.critical} critical · ${counts.jobsAffected} job${counts.jobsAffected === 1 ? "" : "s"} affected · ${counts.actionable} actionable`}
          </CardDescription>
        </div>
        <Pill
          tone={counts.bySeverity.critical > 0 ? "danger" : "neutral"}
        >{`${counts.total} open`}</Pill>
      </div>

      {partial ? (
        <p className="flex items-center gap-2 text-xs text-amber-800" role="status">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Some sources couldn&rsquo;t load — this list may be incomplete.
        </p>
      ) : null}

      {initialItems.length === 0 ? (
        <EmptyState
          title="All clear"
          description="Nothing needs office attention right now. New exceptions from site appear here automatically."
        />
      ) : (
        <>
          {/* View tabs */}
          <div className="flex flex-wrap gap-1" role="tablist" data-testid="exceptions-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded-pill px-3 py-1 text-sm font-medium transition-colors",
                  tab === t.key
                    ? "bg-brand-navy text-text-inverse"
                    : "bg-surface-subtle text-text-muted hover:bg-surface"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Refining filters (apply within every tab) */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              testid="exceptions-filter-source"
              label="Source"
              value={source}
              onChange={(v) => setSource(v as ExceptionSource | "all")}
              options={[
                { value: "all", label: "All sources" },
                ...sourcesPresent.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s })),
              ]}
            />
            <FilterSelect
              testid="exceptions-filter-severity"
              label="Severity"
              value={severity}
              onChange={(v) => setSeverity(v as ExceptionSeverity | "all")}
              options={[
                { value: "all", label: "All severities" },
                ...SEVERITIES.filter((s) => counts.bySeverity[s] > 0).map((s) => ({
                  value: s,
                  label: SEVERITY_LABEL[s],
                })),
              ]}
            />
            {jobs.length > 0 ? (
              <FilterSelect
                testid="exceptions-filter-job"
                label="Job"
                value={jobId}
                onChange={setJobId}
                options={[
                  { value: "all", label: "All jobs" },
                  ...jobs.map((j) => ({ value: j.jobId, label: j.jobName })),
                ]}
              />
            ) : null}
            <label className="inline-flex items-center gap-1 rounded-card border border-border bg-surface px-2 text-text-muted">
              <Search className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Search exceptions</span>
              <input
                data-testid="exceptions-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search job or item…"
                className="bg-transparent py-1.5 text-sm text-text outline-none"
              />
            </label>
          </div>

          {/* Body */}
          {filtered.length === 0 ? (
            <p className="text-sm text-text-muted" data-testid="exceptions-empty-filtered">
              {`None of the ${counts.total} open item${counts.total === 1 ? "" : "s"} match this view — adjust the tab or filters above.`}
            </p>
          ) : grouped ? (
            <GroupedBody tab={tab} items={filtered} />
          ) : (
            <ExceptionList items={filtered} />
          )}
        </>
      )}
    </Card>
  );
}

function GroupedBody({ tab, items }: { tab: TabKey; items: ReadonlyArray<ExceptionItem> }) {
  if (tab === "by-job") {
    const groups = groupExceptionsByJob(items);
    return (
      <div className="space-y-4" data-testid="exceptions-grouped-job">
        {groups.map((g) => (
          <section key={g.jobId ?? "__general__"} aria-label={g.jobName}>
            <div className="mb-1 flex items-center gap-2">
              <h3 className="font-display text-sm font-semibold text-text">{g.jobName}</h3>
              <Pill tone={SEVERITY_TONE[g.highestSeverity]}>{`${g.count}`}</Pill>
            </div>
            <ExceptionList items={g.items} />
          </section>
        ))}
      </div>
    );
  }
  const groups = groupExceptionsBySource(items);
  return (
    <div className="space-y-4" data-testid="exceptions-grouped-source">
      {groups.map((g) => (
        <section key={g.source} aria-label={g.sourceLabel}>
          <div className="mb-1 flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold text-text">{g.sourceLabel}</h3>
            <Pill tone="neutral">{`${g.count}`}</Pill>
          </div>
          <ExceptionList items={g.items} />
        </section>
      ))}
    </div>
  );
}

function ExceptionList({ items }: { items: ReadonlyArray<ExceptionItem> }) {
  return (
    <ul className="divide-y divide-border rounded-card border border-border">
      {items.map((item) => (
        <li key={item.id} className="p-4" data-testid="exception-item">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={SEVERITY_TONE[item.severity]}>{SEVERITY_LABEL[item.severity]}</Pill>
            <Pill tone={SOURCE_TONE[item.source]}>
              {item.sourceLabel ?? SOURCE_LABEL[item.source]}
            </Pill>
            {item.jobName ? <span className="text-xs text-text-muted">{item.jobName}</span> : null}
            {item.ageLabel ? (
              <span className="text-xs text-text-muted">· {item.ageLabel}</span>
            ) : null}
          </div>
          <p className="mt-2 font-medium text-text">{item.title}</p>
          {item.summary ? <p className="mt-0.5 text-sm text-text-muted">{item.summary}</p> : null}
          {isActionable(item) ? (
            <Link
              href={item.actionHref as Route}
              data-testid="exception-action-link"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              {item.actionLabel ?? "Open"}
              {item.actionState === "fallback" ? (
                <span className="text-xs text-text-muted">(job)</span>
              ) : null}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <span
              data-testid="exception-action-unavailable"
              className="mt-2 inline-flex items-center gap-1 text-sm text-text-muted"
              title={item.actionReason ?? undefined}
            >
              {(item.actionLabel ?? "Open") + " — not available yet"}
              {item.actionReason ? <span className="text-xs">· {item.actionReason}</span> : null}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function FilterSelect({
  testid,
  label,
  value,
  onChange,
  options,
}: {
  testid: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-text-muted">
      <span className="sr-only">{label}</span>
      <select
        data-testid={testid}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
