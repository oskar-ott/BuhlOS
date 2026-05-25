"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  isDone,
  needsWorkerAttention,
  priorityLabel,
  priorityTone,
  statusLabel,
  statusTone,
  type SnagPriorityTone,
  type SnagStatusTone,
} from "@/domains/snags/format";
import { transitionSnag } from "@/domains/snags/client";
import { canRoleTransition } from "@/domains/snags/service";
import type { SnagItem } from "@/domains/snags/types";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job, JobStage } from "@/domains/jobs/types";
import { ReportSnagSheet } from "./ReportSnagSheet";
import { cn } from "@/lib/cn";

const STATUS_PILL_TONE: Record<SnagStatusTone, "info" | "success" | "danger" | "warning" | "neutral"> = {
  info: "info",
  success: "success",
  danger: "danger",
  warning: "warning",
  neutral: "neutral",
};

const PRIORITY_PILL_TONE: Record<SnagPriorityTone, "neutral" | "warning" | "danger"> = {
  neutral: "neutral",
  warning: "warning",
  danger: "danger",
};

interface Props {
  job: Job;
  /** Initial snags fetched server-side. May be empty. */
  initialSnags?: ReadonlyArray<SnagItem>;
  /** Worker context inherited from PhilJobDetail — passed into the
   *  report sheet so the snag inherits stage + area without re-asking. */
  context: { stage: JobStage | null; areaId: string | null };
  /** Worker's recent evidence on this job — offered as link targets
   *  in the report sheet. */
  recentEvidence?: ReadonlyArray<EvidenceItem>;
  /** Current viewer — id + role drive which transitions Phil exposes. */
  viewer: { id: string; role: string };
}

type ActionState =
  | { kind: "idle" }
  | { kind: "in_flight"; snagId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * Phil — Job snags panel (Phase D.5).
 *
 * Lives inside PhilJobDetail under the Capture evidence + Today's
 * captures sections so the field user sees one continuous list of
 * "what's going on with this job." Renders:
 *
 *   - Primary CTA: "Report snag" (large, accent-yellow on navy)
 *   - List of active snags (open / in_progress / resolved) on this
 *     job, with a small actions row matching what the viewer's role
 *     can do (claim, mark resolved, re-open).
 *   - Resolved + verified + closed snags fold into a small "Resolved"
 *     pill counter — out of the way but visible.
 *
 * Mirrors TodaysCapturesStrip's mobile-first shape. Doc 27 §8.5
 * applies: clear next action, no dense tables, no admin controls.
 */
export function JobSnagsPanel({
  job,
  initialSnags = [],
  context,
  recentEvidence = [],
  viewer,
}: Props) {
  const [snags, setSnags] = useState<ReadonlyArray<SnagItem>>(initialSnags);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  // Surface includes open / in_progress / resolved AND rejected so
  // the worker sees the admin's pushback reason in their feed.
  // Without rejected here, the operational loop is broken — admin
  // rejects with a reason and the worker never sees it.
  const visible = useMemo(
    () => snags.filter((s) => needsWorkerAttention(s.status)),
    [snags]
  );
  const doneCount = useMemo(
    () => snags.filter((s) => isDone(s.status)).length,
    [snags]
  );

  const applyServer = useCallback((next: SnagItem) => {
    setSnags((prev) => prev.map((s) => (s.id === next.id ? next : s)));
  }, []);

  const handleCreated = useCallback((item: SnagItem) => {
    setSnags((prev) => [item, ...prev]);
    setAction({ kind: "success", message: "Snag reported." });
    window.setTimeout(() => setAction({ kind: "idle" }), 1500);
  }, []);

  const handleFailed = useCallback((message: string) => {
    setAction({ kind: "error", message });
  }, []);

  const runTransition = useCallback(
    async (snag: SnagItem, nextStatus: SnagItem["status"]) => {
      setAction({ kind: "in_flight", snagId: snag.id });
      const r = await transitionSnag(job.id, {
        snagId: snag.id,
        nextStatus,
      });
      if (r.ok) {
        applyServer(r.data.snagItem);
        setAction({
          kind: "success",
          message: messageForTransition(snag.status, nextStatus),
        });
        window.setTimeout(
          () =>
            setAction((curr) =>
              curr.kind === "success" ? { kind: "idle" } : curr
            ),
          1500
        );
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "You can't change this snag's status."
              : r.error.status === 400
                ? "Couldn't update — the snag may have changed since you loaded the page."
                : r.error.message || "Couldn't update snag. Try again.",
        });
      }
    },
    [job.id, applyServer]
  );

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Snags</CardTitle>
          <CardDescription className="mt-1">
            Issues raised on this job. Tap Report snag if something needs
            fixing.
          </CardDescription>
        </div>
        {doneCount > 0 ? (
          <Pill tone="success">{doneCount} done</Pill>
        ) : null}
      </div>

      <div className="mt-3">
        <Button
          type="button"
          variant="primary"
          size="lg"
          onClick={() => {
            setAction({ kind: "idle" });
            setSheetOpen(true);
          }}
          className="w-full bg-accent-yellow text-brand-navy hover:bg-accent-yellow"
        >
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
          Report snag
        </Button>
      </div>

      <ActionFeedback state={action} />

      {visible.length === 0 ? (
        <p
          className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted"
          role="status"
        >
          No open snags on this job.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((s) => (
            <SnagRow
              key={s.id}
              snag={s}
              viewer={viewer}
              busy={action.kind === "in_flight" && action.snagId === s.id}
              onTransition={runTransition}
            />
          ))}
        </ul>
      )}

      <ReportSnagSheet
        open={sheetOpen}
        job={job}
        initialContext={context}
        recentEvidence={recentEvidence}
        onClose={() => setSheetOpen(false)}
        onCreated={handleCreated}
        onFailed={handleFailed}
      />
    </Card>
  );
}

interface RowProps {
  snag: SnagItem;
  viewer: { id: string; role: string };
  busy: boolean;
  onTransition: (snag: SnagItem, next: SnagItem["status"]) => void;
}

function SnagRow({ snag, viewer, busy, onTransition }: RowProps) {
  const ctx = {
    userId: viewer.id,
    role: viewer.role,
    creatorId: snag.createdById ?? null,
    assignedToId: snag.assignedToId ?? null,
  };

  const canClaim =
    snag.status === "open" && canRoleTransition("open", "in_progress", ctx);
  const canResolve =
    snag.status === "in_progress" &&
    canRoleTransition("in_progress", "resolved", ctx);
  const canReopen =
    snag.status === "resolved" &&
    canRoleTransition("resolved", "in_progress", ctx);

  return (
    <li
      className={cn(
        "rounded-card border border-border bg-surface p-3",
        snag.status === "rejected" ? "border-rose-200 bg-rose-50/40" : "",
        busy ? "opacity-70" : ""
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words font-display text-sm font-semibold text-text">
            {snag.title}
          </p>
          {snag.description ? (
            <p className="mt-0.5 break-words text-sm text-text-muted">
              {snag.description}
            </p>
          ) : null}
          {snag.areaName ? (
            <p className="mt-1 text-xs text-text-muted">{snag.areaName}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Pill tone={STATUS_PILL_TONE[statusTone(snag.status)]}>
            {statusLabel(snag.status)}
          </Pill>
          <Pill tone={PRIORITY_PILL_TONE[priorityTone(snag.priority)]}>
            {priorityLabel(snag.priority)}
          </Pill>
        </div>
      </div>
      {snag.status === "rejected" && snag.rejectionReason ? (
        <div
          role="alert"
          className="mt-2 rounded-card border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-900"
        >
          <p className="font-display text-[11px] uppercase tracking-wider text-rose-700">
            Rejected{snag.rejectedByName ? ` by ${snag.rejectedByName}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line break-words">
            {snag.rejectionReason}
          </p>
        </div>
      ) : null}
      {canClaim || canResolve || canReopen ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canClaim ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => onTransition(snag, "in_progress")}
            >
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              I&rsquo;ll fix it
            </Button>
          ) : null}
          {canResolve ? (
            <Button
              size="lg"
              variant="primary"
              disabled={busy}
              onClick={() => onTransition(snag, "resolved")}
              className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
            >
              {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              Mark resolved
            </Button>
          ) : null}
          {canReopen ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => onTransition(snag, "in_progress")}
            >
              Re-open
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ActionFeedback({ state }: { state: ActionState }) {
  if (state.kind === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-3 flex items-center gap-2 rounded-card border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
      >
        <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
        {state.message}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="mt-3 rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
      >
        {state.message}
      </div>
    );
  }
  return null;
}

function messageForTransition(
  from: SnagItem["status"],
  to: SnagItem["status"]
): string {
  if (from === "open" && to === "in_progress") return "Picked up. You own it now.";
  if (from === "in_progress" && to === "resolved")
    return "Marked resolved. Admin will verify.";
  if (from === "resolved" && to === "in_progress") return "Re-opened.";
  if (from === "in_progress" && to === "open") return "Dropped. Back to open.";
  if (from === "resolved" && to === "open") return "Re-opened.";
  return "Updated.";
}
