"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  formatProgress,
  isDone,
  needsWorkerAttention,
  scopeContextLine,
  statusLabel,
  statusTone,
  type ITPStatusTone,
} from "@/domains/itp/format";
import type { ITPInstance } from "@/domains/itp/types";
import { resolveScopeName } from "./itp-scope";
import { cn } from "@/lib/cn";
import type { Job } from "@/domains/jobs/types";

interface Props {
  job: Job;
  /** Initial ITP instances fetched server-side. May be empty. */
  initialItps?: ReadonlyArray<ITPInstance>;
}

const STATUS_PILL_TONE: Record<
  ITPStatusTone,
  "info" | "success" | "warning" | "neutral"
> = {
  info: "info",
  success: "success",
  warning: "warning",
  neutral: "neutral",
};

/**
 * Phil — Job ITP / QA panel (Phase E1b).
 *
 * Replaces the PR #37 UC stub now that the field recording surface
 * exists. Sits below JobSnagsPanel in PhilJobDetail (testing-checklist
 * §B.2 render order: header → site → stage → areas → capture → today's
 * strip → Snags → ITPs).
 *
 * Pattern mirrors JobSnagsPanel:
 *   - Active instances surfaced front and centre (pending / in-progress
 *     / witnessed).
 *   - Signed-off count folded into a small "N done" pill — visible but
 *     out of the way.
 *   - Each row taps into /phil/jobs/[jobId]/itps/[instanceId].
 *
 * No inline mutations — all recording lives on the per-instance page so
 * the panel never has to deal with mid-flight state.
 *
 * Cross-ref:
 *   src/components/phil/JobSnagsPanel.tsx — pattern precedent
 *   src/domains/itp/format.ts — statusLabel / statusTone / formatProgress
 *   src/app/phil/jobs/[jobId]/itps/[instanceId]/page.tsx — recording target
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1b
 */
export function JobItpPanel({ job, initialItps = [] }: Props) {
  // The server returns archived instances too (admin sometimes needs to
  // see what got removed); for Phil they're gone.
  const live = useMemo(
    () => initialItps.filter((i) => !i.archived),
    [initialItps],
  );
  const active = useMemo(
    () => live.filter((i) => needsWorkerAttention(i.status)),
    [live],
  );
  const doneCount = useMemo(
    () => live.filter((i) => isDone(i.status)).length,
    [live],
  );

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>ITPs</CardTitle>
          <CardDescription className="mt-1">
            Inspection &amp; test plans for this job. Tap one to record
            points as you go.
          </CardDescription>
        </div>
        {doneCount > 0 ? (
          <Pill tone="success">{doneCount} done</Pill>
        ) : null}
      </div>

      {active.length === 0 ? (
        <p
          className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted"
          role="status"
        >
          {live.length === 0
            ? "No ITPs attached to this job yet. Your PM or leading hand attaches them."
            : "All attached ITPs are signed off. Good work."}
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {active.map((instance) => (
            <li key={instance.id}>
              <ItpRow job={job} instance={instance} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ItpRow({ job, instance }: { job: Job; instance: ITPInstance }) {
  const progress = formatProgress(instance);
  const scopeName = resolveScopeName(job, instance);
  const scopeLine = scopeContextLine(instance.scope, scopeName);
  const templateName =
    instance.templateSnapshot?.name?.trim() || "Untitled ITP";
  const href =
    `/phil/jobs/${encodeURIComponent(job.id)}/itps/${encodeURIComponent(instance.id)}` as Route;
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-[64px] items-center gap-3 rounded-card border border-border bg-surface px-4 py-3",
        "transition-colors hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy",
      )}
      aria-label={`Open ITP: ${templateName} — ${progress.done} of ${progress.total} points recorded`}
    >
      <ClipboardCheck
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-text-muted"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-base font-semibold text-text">
          {templateName}
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-muted">
          {scopeLine}
        </span>
        <span className="mt-1 inline-flex items-center gap-2 text-xs text-text-muted">
          <Pill tone={STATUS_PILL_TONE[statusTone(instance.status)]}>
            {statusLabel(instance.status)}
          </Pill>
          <span>
            {progress.done} / {progress.total}
            {progress.total > 0 ? " points" : null}
          </span>
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-text-muted/60"
      />
    </Link>
  );
}
