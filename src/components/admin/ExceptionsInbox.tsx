"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  filterExceptions,
  isSafeActionHref,
  jobOptions,
  summariseExceptions,
} from "@/domains/exceptions/service";
import type {
  ExceptionItem,
  ExceptionSeverity,
  ExceptionSource,
} from "@/domains/exceptions/types";

/**
 * "Needs Attention" — the itemised Exceptions Inbox on the Command Centre.
 *
 * Renders a deterministic PROJECTION (built server-side from already-loaded,
 * admin-gated sources) as an actionable list: every row says what happened,
 * which job, why it matters, and the next action (a canonical internal link).
 * It stores nothing and exposes no raw source records — items arrive
 * pre-projected via props. Field workers never reach this surface (the
 * Command Centre page is admin-gated).
 */

const SOURCE_LABEL: Record<ExceptionSource, string> = {
  hours: "Hours",
  observation: "Observation",
  evidence: "Evidence",
  snag: "Snags",
  itp: "ITP",
  job: "Jobs",
  material: "Materials",
  planMarkup: "Plan markup",
  gear: "Gear",
};
const SEVERITY_TONE: Record<ExceptionSeverity, "danger" | "warning" | "info"> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};
const SEVERITY_LABEL: Record<ExceptionSeverity, string> = {
  critical: "Critical",
  warning: "Action",
  info: "Info",
};
const SEVERITIES: ExceptionSeverity[] = ["critical", "warning", "info"];

interface Props {
  initialItems: ReadonlyArray<ExceptionItem>;
  /** True when one or more source loads failed (list may be incomplete). */
  partial?: boolean;
}

export function ExceptionsInbox({ initialItems, partial = false }: Props) {
  const [source, setSource] = useState<ExceptionSource | "all">("all");
  const [severity, setSeverity] = useState<ExceptionSeverity | "all">("all");
  const [jobId, setJobId] = useState<string>("all");

  const summary = useMemo(() => summariseExceptions(initialItems), [initialItems]);
  const jobs = useMemo(() => jobOptions(initialItems), [initialItems]);
  const sourcesPresent = useMemo(
    () => [...new Set(initialItems.map((i) => i.source))].sort(),
    [initialItems],
  );
  const filtered = useMemo(
    () => filterExceptions(initialItems, { source, severity, jobId }),
    [initialItems, source, severity, jobId],
  );

  return (
    <Card className="space-y-4" data-testid="exceptions-inbox">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription className="mt-1">
            {summary.total === 0
              ? "Item-by-item view of what the office needs to action."
              : `${summary.total} open item${summary.total === 1 ? "" : "s"} — ${summary.bySeverity.critical} critical, ${summary.bySeverity.warning} to action.`}
          </CardDescription>
        </div>
        <Pill tone={summary.bySeverity.critical > 0 ? "danger" : "neutral"}>
          {`${summary.total} open`}
        </Pill>
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
          <div className="flex flex-wrap gap-2">
            <FilterSelect
              testid="exceptions-filter-source"
              label="Source"
              value={source}
              onChange={(v) => setSource(v as ExceptionSource | "all")}
              options={[
                { value: "all", label: "All sources" },
                ...sourcesPresent.map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
              ]}
            />
            <FilterSelect
              testid="exceptions-filter-severity"
              label="Severity"
              value={severity}
              onChange={(v) => setSeverity(v as ExceptionSeverity | "all")}
              options={[
                { value: "all", label: "All severities" },
                ...SEVERITIES.filter((s) => summary.bySeverity[s] > 0).map((s) => ({
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
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-text-muted" data-testid="exceptions-empty-filtered">
              No items match these filters.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border">
              {filtered.map((item) => (
                <li key={item.id} className="p-4" data-testid="exception-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={SEVERITY_TONE[item.severity]}>{SEVERITY_LABEL[item.severity]}</Pill>
                    <Pill tone="neutral">{SOURCE_LABEL[item.source]}</Pill>
                    {item.jobName ? (
                      <span className="text-xs text-text-muted">{item.jobName}</span>
                    ) : null}
                  </div>
                  <p className="mt-2 font-medium text-text">{item.title}</p>
                  {item.summary ? (
                    <p className="mt-0.5 text-sm text-text-muted">{item.summary}</p>
                  ) : null}
                  {isSafeActionHref(item.actionHref) ? (
                    <Link
                      href={item.actionHref as Route}
                      className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
                    >
                      {item.actionLabel ?? "Open"}
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
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
