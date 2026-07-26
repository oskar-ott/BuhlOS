"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, ArrowRight, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { pctWidthClass } from "@/components/admin/pct-width";
import { timesheetsClient } from "@/domains/timesheets/client";
import { requestLeave, clearLeave } from "@/domains/timesheets/client";
import { formatDateLabel, formatHoursLabel, otSplitLabel } from "@/domains/timesheets/format";
import {
  submittedWeekSelection,
  weeklyDayStatusLabel,
  type WeeklyHoursCloseout,
  type WeeklyHoursDay,
  type WeeklyWorkerHours,
} from "@/domains/timesheets/weekly-closeout";
import {
  buildPayRun,
  workerStrip,
  wholeDollarsFromCents,
  type StripTone,
} from "@/domains/timesheets/pay-run";
import { WeekShapeStrip, WeekShapeLegend } from "@/components/admin/WeekShapeStrip";
import { WeeklyCloseoutWizard } from "@/components/admin/WeeklyCloseoutWizard";

/**
 * The interactive part of /hours/weekly (desktop tree) — lean-reset redesign.
 * The server component fetches one week of /api/time-entries-overview, derives
 * the closeout model (buildWeeklyHoursCloseout) and passes it in; this
 * component renders the design's This-week surface — the "Week of" card with
 * the yellow "Start weekly closeout" wizard trigger, one card per worker
 * (week total + status chip + the seven-day strip + in-place approve/reject on
 * each submitted day) and the pay-period pointer — and fires the SAME
 * approve / reject endpoints the approvals queue uses (timesheetsClient) — no
 * second status-transition implementation. After every action it refreshes the
 * route so the model is rebuilt from persisted state, never locally guessed.
 *
 * Lives in src/components/admin/ (not next to the page) for the same
 * Next.js 15.5 React Client Manifest bug that bit /hours/approvals — see
 * HoursApprovalsQueue.tsx for the digest.
 */

const HOURS_WEEKLY: Route = "/hours/weekly" as Route;
const HOURS_PERIOD: Route = "/hours/period" as Route;

/** Week navigation for the "Week of" card — `?week=` values, sacred URLs. */
export interface WeeklyBoardWeekNav {
  prevWeek: string;
  nextWeek: string;
  currentWeek: string;
  isCurrentWeek: boolean;
}

interface WeeklyHoursCloseoutBoardProps {
  closeout: WeeklyHoursCloseout;
  fetchError: string | null;
  /** True when the viewer can undo (reopen is admin-tier; leading hands
   *  approve but cannot reopen, so they never see a button that would 403). */
  canUndo?: boolean;
  /** Week arrows for the "Week of" card; omitted in tests. */
  weekNav?: WeeklyBoardWeekNav;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "approving"; key: string }
  | { kind: "rejecting"; key: string }
  | { kind: "success"; label: string }
  | { kind: "error"; message: string };

/** Result of one "Approve all N days" call — per-day truth, never a rollup lie. */
interface BulkOutcome {
  workerName: string;
  approvedCount: number;
  failed: Array<{ date: string | null; error: string }>;
  /** Entries the viewer can still revert (cleared when the 30s window ends). */
  undo: Array<{ userId: string; date: string }>;
}

function dayKey(workerId: string, date: string): string {
  return `${workerId}:${date}`;
}

/** "Mon 8" — board row label, UTC-parsed like the field-app strip. */
function dayLabel(day: WeeklyHoursDay): string {
  const num = new Date(day.date + "T00:00:00Z").toLocaleDateString("en-AU", {
    day: "numeric",
    timeZone: "UTC",
  });
  return `${day.weekday} ${num}`;
}

/** The replica's per-worker status chip: Ready / Sent back / N to approve /
 *  Missing hours — sent-back outranks the approve count (the office caused it). */
function workerStatusChip(worker: WeeklyWorkerHours): {
  tone: "success" | "danger" | "info" | "warning";
  label: string;
} {
  if (worker.readiness === "payroll-ready") return { tone: "success", label: "Ready" };
  if (worker.rejectedCount > 0) return { tone: "danger", label: "Sent back" };
  if (worker.submittedCount > 0)
    return { tone: "info", label: `${worker.submittedCount} to approve` };
  if (worker.missingCount > 0) return { tone: "warning", label: "Missing hours" };
  // Remaining open state is a draft — waiting on the worker to submit.
  return { tone: "warning", label: "Waiting for worker" };
}

/** The replica's bulk label: "Approve this day" / "Approve all N days". */
function bulkApproveLabel(submittedCount: number): string {
  return submittedCount === 1 ? "Approve this day" : `Approve all ${submittedCount} days`;
}

export function WeeklyHoursCloseoutBoard({
  closeout,
  fetchError,
  canUndo = false,
  weekNav,
}: WeeklyHoursCloseoutBoardProps) {
  const router = useRouter();
  const payRun = buildPayRun(closeout);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [bulk, setBulk] = useState<BulkOutcome | null>(null);
  const [bulkBusyWorker, setBulkBusyWorker] = useState<string | null>(null);
  // "Approve all clean" runs across workers, so it is tracked separately from
  // the per-worker bulk busy flag.
  const [cleanSweepBusy, setCleanSweepBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  // Monotonic id so a stale 30s timer never clears a NEWER bulk result.
  const bulkSeqRef = useRef(0);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [markTarget, setMarkTarget] = useState<{
    worker: WeeklyWorkerHours;
    day: WeeklyHoursDay;
  } | null>(null);
  const [markType, setMarkType] = useState("annual");
  const [markBusy, setMarkBusy] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<{
    worker: WeeklyWorkerHours;
    day: WeeklyHoursDay;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  // Reopen (#125): unwind an approved/rejected day with a reason. Exported
  // entries get the endpoint's block message + an explicit force step.
  const [reopenTarget, setReopenTarget] = useState<{
    worker: WeeklyWorkerHours;
    day: WeeklyHoursDay;
  } | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenToStatus, setReopenToStatus] = useState<"submitted" | "draft">("submitted");
  const [reopenBlock, setReopenBlock] = useState<string | null>(null);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [, startTransition] = useTransition();

  const weekLabel = `${formatDateLabel(closeout.weekStart)} – ${formatDateLabel(closeout.weekEnd)}`;

  // Distinct strip tones present in the run — drives the legend (we only show
  // legend entries for states that actually appear, never a key for a tone the
  // week doesn't contain).
  const stripTones = new Set<StripTone>();
  for (const w of closeout.workers) {
    for (const cell of workerStrip(w)) stripTones.add(cell.tone);
  }
  // "empty" cells (future / not-required) carry no decision meaning — keep them
  // off the legend so it stays about real states.
  stripTones.delete("empty");

  // #127: mark a missing day as not-worked (records approved leave on the
  // worker's behalf via #333's store) and undo it. The day flips to "leave"
  // and stops counting as missing; readiness recomputes server-side.
  async function confirmMark() {
    if (!markTarget) return;
    const { worker, day } = markTarget;
    setMarkBusy(true);
    setAction({ kind: "idle" });
    const res = await requestLeave({
      userId: worker.workerId,
      type: markType,
      fromDate: day.date,
      toDate: day.date,
    });
    setMarkBusy(false);
    setMarkTarget(null);
    if (!res.ok) {
      setAction({ kind: "error", message: res.error.message });
      return;
    }
    setAction({ kind: "success", label: `${dayLabel(day)} marked not worked for ${worker.workerName}.` });
    startTransition(() => router.refresh());
  }

  async function undoLeave(worker: WeeklyWorkerHours, day: WeeklyHoursDay) {
    setAction({ kind: "idle" });
    const res = await clearLeave(worker.workerId, day.date);
    if (!res.ok) {
      setAction({ kind: "error", message: res.error.message });
      return;
    }
    setAction({ kind: "success", label: `Cleared ${dayLabel(day)} for ${worker.workerName}.` });
    startTransition(() => router.refresh());
  }

  async function approveWeek(worker: WeeklyWorkerHours) {
    const entries = submittedWeekSelection(worker);
    if (entries.length === 0 || bulkBusyWorker) return;
    setBulkBusyWorker(worker.workerId);
    setAction({ kind: "idle" });
    setBulk(null);
    const result = await timesheetsClient.bulkApproveEntries({ entries });
    setBulkBusyWorker(null);
    if (!result.ok) {
      setAction({
        kind: "error",
        message:
          result.error.status === 403
            ? "You don't have permission to approve these entries."
            : result.error.message || "Couldn't approve the week. Try again.",
      });
      return;
    }
    bulkSeqRef.current += 1;
    const seq = bulkSeqRef.current;
    const undo = canUndo
      ? result.data.approved.map((a) => ({ userId: a.userId, date: a.date }))
      : [];
    setBulk({
      workerName: worker.workerName,
      approvedCount: result.data.approvedCount,
      failed: result.data.failed.map((f) => ({ date: f.date, error: f.error })),
      undo,
    });
    if (undo.length > 0) {
      // The undo window matches single-approve affordances: 30 seconds, then
      // the revert path is the admin reopen flow, not a stale button.
      setTimeout(() => {
        if (bulkSeqRef.current === seq) setBulk((b) => (b ? { ...b, undo: [] } : b));
      }, 30_000);
    }
    startTransition(() => router.refresh());
  }

  /**
   * "Approve all clean" — one bulk call for every submitted day of every
   * CLEAN week (workers whose only open state is pending-approval). Flagged
   * weeks (rejected / draft / missing) are never swept; they need a look. Same
   * endpoint and outcome surface as the per-worker bulk approve.
   */
  async function approveAllClean() {
    const entries = [...payRun.cleanApproval];
    if (entries.length === 0 || cleanSweepBusy || bulkBusyWorker) return;
    setCleanSweepBusy(true);
    setAction({ kind: "idle" });
    setBulk(null);
    const result = await timesheetsClient.bulkApproveEntries({ entries });
    setCleanSweepBusy(false);
    if (!result.ok) {
      setAction({
        kind: "error",
        message:
          result.error.status === 403
            ? "You don't have permission to approve these entries."
            : result.error.message || "Couldn't approve the clean weeks. Try again.",
      });
      return;
    }
    bulkSeqRef.current += 1;
    const seq = bulkSeqRef.current;
    const undo = canUndo
      ? result.data.approved.map((a) => ({ userId: a.userId, date: a.date }))
      : [];
    const sweptWorkers = new Set(result.data.approved.map((a) => a.userId)).size;
    setBulk({
      workerName: `${sweptWorkers} ${sweptWorkers === 1 ? "clean week" : "clean weeks"}`,
      approvedCount: result.data.approvedCount,
      failed: result.data.failed.map((f) => ({ date: f.date, error: f.error })),
      undo,
    });
    if (undo.length > 0) {
      setTimeout(() => {
        if (bulkSeqRef.current === seq) setBulk((b) => (b ? { ...b, undo: [] } : b));
      }, 30_000);
    }
    startTransition(() => router.refresh());
  }

  async function undoBulk() {
    if (!bulk || bulk.undo.length === 0 || undoBusy) return;
    setUndoBusy(true);
    const failures: string[] = [];
    // Sequential — same reasoning as the endpoint: per-user day blobs are
    // cheap and serial writes can't step on each other.
    for (const ref of bulk.undo) {
      const r = await timesheetsClient.reopenEntry({
        userId: ref.userId,
        date: ref.date,
        toStatus: "submitted",
      });
      if (!r.ok) failures.push(`${ref.date}: ${r.error.message || `HTTP ${r.error.status}`}`);
    }
    const total = bulk.undo.length;
    setUndoBusy(false);
    setBulk(null);
    setAction(
      failures.length === 0
        ? { kind: "success", label: `Undo complete — ${total} ${total === 1 ? "day" : "days"} back to submitted.` }
        : { kind: "error", message: `Undo incomplete — ${failures.length} of ${total} couldn't be reopened: ${failures.join("; ")}` }
    );
    startTransition(() => router.refresh());
  }

  function openReopen(worker: WeeklyWorkerHours, day: WeeklyHoursDay) {
    setReopenTarget({ worker, day });
    setReopenReason("");
    setReopenToStatus("submitted");
    setReopenBlock(null);
  }

  async function confirmReopen(force: boolean) {
    if (!reopenTarget || reopenBusy) return;
    const trimmed = reopenReason.trim();
    if (!trimmed) {
      setAction({ kind: "error", message: "A reopen reason is required — it's stamped on the entry and the audit trail." });
      return;
    }
    const { worker, day } = reopenTarget;
    setReopenBusy(true);
    const result = await timesheetsClient.reopenEntry({
      userId: worker.workerId,
      date: day.date,
      toStatus: reopenToStatus,
      reason: trimmed,
      ...(force ? { force: true } : {}),
    });
    setReopenBusy(false);
    if (result.ok) {
      setReopenTarget(null);
      setReopenBlock(null);
      setAction({
        kind: "success",
        label:
          reopenToStatus === "submitted"
            ? `Reopened ${worker.workerName}'s ${dayLabel(day)} — back in the approvals queue.`
            : `Reopened ${worker.workerName}'s ${dayLabel(day)} as a draft — back with the worker.`,
      });
      startTransition(() => router.refresh());
      return;
    }
    if (result.error.status === 409 && !force) {
      // Already in a sent payroll file — surface the endpoint's own message
      // and require a second, explicit confirmation before forcing.
      setReopenBlock(result.error.message || "This entry is already in a sent payroll export.");
      return;
    }
    setReopenTarget(null);
    setAction({
      kind: "error",
      message:
        result.error.status === 403
          ? "Reopening needs an office login."
          : result.error.message || "Couldn't reopen. Try again.",
    });
  }

  async function approve(worker: WeeklyWorkerHours, day: WeeklyHoursDay) {
    const key = dayKey(worker.workerId, day.date);
    setAction({ kind: "approving", key });
    const result = await timesheetsClient.approveEntry({
      userId: worker.workerId,
      date: day.date,
    });
    if (result.ok) {
      setAction({
        kind: "success",
        label: `Approved ${formatHoursLabel(day.hours ?? 0)} for ${worker.workerName} on ${dayLabel(day)}.`,
      });
      startTransition(() => router.refresh());
      return;
    }
    setAction({
      kind: "error",
      message:
        result.error.status === 403
          ? "You don't have permission to approve this entry."
          : result.error.message || "Couldn't approve. Try again.",
    });
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    const trimmed = rejectReason.trim();
    if (!trimmed) {
      setAction({ kind: "error", message: "Rejection reason is required." });
      return;
    }
    const { worker, day } = rejectTarget;
    setAction({ kind: "rejecting", key: dayKey(worker.workerId, day.date) });
    setRejectTarget(null);
    const result = await timesheetsClient.rejectEntry({
      userId: worker.workerId,
      date: day.date,
      reason: trimmed,
    });
    if (result.ok) {
      setAction({
        kind: "success",
        label: `Rejected ${worker.workerName}'s ${dayLabel(day)}. They'll get a push with the reason and a one-tap fix link.`,
      });
      startTransition(() => router.refresh());
      return;
    }
    setAction({
      kind: "error",
      message:
        result.error.status === 403
          ? "You don't have permission to reject this entry."
          : result.error.message || "Couldn't reject. Try again.",
    });
  }

  return (
    <div className="space-y-4">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the week</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. The closeout below may be incomplete — refresh before
            making decisions.
          </CardDescription>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      {/* ── "Week of" card — the design's header: range + nav, the yellow
             wizard trigger, the explainer, and the run's progress + the
             always-safe clean sweep (kept behaviour from the old hero). */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Week of</CardTitle>
            <CardDescription className="mt-1">{weekLabel}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {weekNav ? (
              <div className="flex items-center gap-1">
                <WeekNavLink
                  week={weekNav.prevWeek}
                  label="Previous week"
                  icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />}
                />
                {!weekNav.isCurrentWeek ? (
                  <Link
                    href={{ pathname: HOURS_WEEKLY, query: { week: weekNav.currentWeek } }}
                    className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
                  >
                    This week
                  </Link>
                ) : null}
                <WeekNavLink
                  week={weekNav.nextWeek}
                  label="Next week"
                  icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}
                />
              </div>
            ) : null}
            <button
              type="button"
              data-testid="start-weekly-closeout"
              disabled={closeout.workers.length === 0}
              onClick={() => setWizardOpen(true)}
              className="inline-flex h-10 items-center gap-2 rounded-card bg-accent-yellow px-4 font-display text-sm font-bold text-brand-navy shadow-card hover:brightness-95 active:translate-y-px disabled:opacity-50 disabled:hover:brightness-100"
            >
              <Play aria-hidden="true" className="h-4 w-4 fill-current" />
              Start weekly closeout
            </button>
          </div>
        </div>
        <CardDescription className="mt-3">
          Hours are approved once a week, here. Submitted days sit under each
          worker — approve them in place, or reject with a reason and the day
          bounces back to that worker&rsquo;s phone.
        </CardDescription>

        {payRun.hero.crewCount > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
              <span>
                <b className="font-semibold text-text tabular-nums">
                  {payRun.hero.loggedHoursShort}h
                </b>{" "}
                logged
              </span>
              {payRun.hero.labourLabel ? (
                <span>
                  <span aria-hidden="true">· </span>
                  <b className="font-semibold text-text tabular-nums">
                    {payRun.hero.labourLabel}
                  </b>{" "}
                  labour
                </span>
              ) : null}
              <span>
                <span aria-hidden="true">· </span>
                <b className="font-semibold text-text tabular-nums">{payRun.hero.crewCount}</b>{" "}
                {payRun.hero.crewCount === 1 ? "worker" : "crew"}
              </span>
              {payRun.hero.needLookCount > 0 ? (
                <span className="text-state-danger">
                  <span aria-hidden="true">· </span>
                  <b className="font-semibold tabular-nums">{payRun.hero.needLookCount}</b> need a
                  look
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <div className="w-40 space-y-1">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-subtle"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={payRun.hero.progressPct}
                  aria-label="Workers approved this week"
                >
                  <div
                    aria-hidden="true"
                    className={cn(
                      "h-full rounded-pill bg-accent-yellow transition-[width]",
                      pctWidthClass(payRun.hero.readyCount, payRun.hero.crewCount),
                    )}
                  />
                </div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                  {payRun.hero.readyCount} of {payRun.hero.crewCount} approved
                </p>
              </div>
              {payRun.hero.allReady ? (
                <Pill tone="success">All approved</Pill>
              ) : payRun.cleanWorkerCount > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={approveAllClean}
                  disabled={cleanSweepBusy}
                >
                  {cleanSweepBusy
                    ? "Approving clean weeks…"
                    : `Approve all clean · ${payRun.cleanWorkerCount}`}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      <ActionFeedback state={action} />

      {bulk ? (
        <Card
          className={bulk.failed.length > 0 ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardDescription className={bulk.failed.length > 0 ? "text-amber-900" : "text-emerald-900"}>
              {`Approved ${bulk.approvedCount} ${bulk.approvedCount === 1 ? "day" : "days"} for ${bulk.workerName}.${bulk.failed.length > 0 ? ` ${bulk.failed.length} failed:` : ""}`}
            </CardDescription>
            {bulk.undo.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={undoBulk} disabled={undoBusy}>
                {undoBusy ? "Undoing…" : `Undo (${bulk.undo.length})`}
              </Button>
            ) : null}
          </div>
          {bulk.failed.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
              {bulk.failed.map((f, i) => (
                <li key={`${f.date ?? "unknown"}-${i}`}>{`${f.date ?? "unknown day"} — ${f.error}`}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {closeout.workers.length === 0 ? (
        <EmptyState
          title="No hours found for this week"
          description="No worker logged hours and the server flagged no missing days in this range. Nothing to close out."
        />
      ) : (
        <>
          {/* One card per worker per week — flagged ones first (the model
              already sorts needs-action → ready). Name + week total + status
              chip, the Mon–Sun strip, then the submitted days with in-place
              Approve / Reject and the bulk "Approve all N days". */}
          <Card className="divide-y divide-border p-0">
            {closeout.workers.map((w) => (
              <WorkerRow
                key={w.workerId}
                worker={w}
                action={action}
                bulkBusy={bulkBusyWorker === w.workerId}
                canReopen={canUndo}
                onApprove={approve}
                onApproveWeek={approveWeek}
                onReopen={openReopen}
                onMarkNotWorked={(worker, day) => setMarkTarget({ worker, day })}
                onUndoLeave={undoLeave}
                onReject={(worker, day) => {
                  setRejectTarget({ worker, day });
                  setRejectReason("");
                }}
              />
            ))}
          </Card>

          {stripTones.size > 0 ? (
            <div className="rounded-card border border-border bg-surface-subtle px-4 py-3">
              <p className="mb-2 font-display text-xs uppercase tracking-widest text-text-muted">
                Week strip
              </p>
              <WeekShapeLegend tones={stripTones} />
            </div>
          ) : null}
        </>
      )}

      {/* ── Pay-period pointer — the design's "Payroll export" card. The
             committed run itself lives on the Pay period tab (and the batch
             panel); this card only says whether the week is clear to roll up. */}
      <Card>
        <CardTitle>Payroll export</CardTitle>
        <CardDescription className="mt-1.5">
          Once every worker&rsquo;s week is approved, roll the period up for
          payroll on the Pay period tab.{" "}
          {closeout.workers.length === 0 ? null : closeout.summary.payrollReady ? (
            <span className="font-semibold text-emerald-700">
              This week is fully approved.
            </span>
          ) : (
            <span className="text-amber-900">
              {closeout.summary.workersNeedAction}{" "}
              {closeout.summary.workersNeedAction === 1 ? "worker still needs" : "workers still need"}{" "}
              a decision before payroll.
            </span>
          )}
        </CardDescription>
        {closeout.summary.approvedHours > 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            <span className="font-display font-semibold text-text tabular-nums">
              {formatHoursLabel(closeout.summary.approvedHours)}
            </span>{" "}
            approved so far
            {closeout.approvedByJob.length > 0 ? (
              <span>
                {" · "}
                {closeout.approvedByJob
                  .map((j) => `${j.jobName} ${formatHoursLabel(j.hours)}`)
                  .join(" · ")}
              </span>
            ) : null}
          </p>
        ) : null}
        <div className="mt-3.5">
          <Link
            href={HOURS_PERIOD}
            className="inline-flex items-center rounded-card border border-border px-4 py-2 text-sm font-semibold text-text hover:border-brand-navy"
          >
            Open pay period →
          </Link>
        </div>
      </Card>

      <p className="text-xs text-text-muted">
        Approving a week sends it to the payroll rollup. Workers can still see
        their hours in the field app; only the office approves. Rejecting a day
        bounces it back to the worker on their phone with your reason.
      </p>

      {wizardOpen ? (
        <WeeklyCloseoutWizard
          closeout={closeout}
          weekLabel={weekLabel}
          canUndo={canUndo}
          onClose={() => setWizardOpen(false)}
        />
      ) : null}

      <Modal
        open={rejectTarget !== null}
        onClose={() => {
          setRejectTarget(null);
          setRejectReason("");
        }}
        title={
          rejectTarget
            ? `Reject ${rejectTarget.worker.workerName}'s ${dayLabel(rejectTarget.day)}`
            : "Reject"
        }
      >
        <div className="space-y-4">
          {rejectTarget ? (
            <p className="text-sm text-text-muted">
              {formatHoursLabel(rejectTarget.day.hours ?? 0)}
              {rejectTarget.day.jobLabel ? ` on ${rejectTarget.day.jobLabel}` : ""}. The reason
              is shared with the worker in a push notification.
            </p>
          ) : null}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-text">Reason (required)</span>
            <textarea
              autoFocus
              rows={3}
              maxLength={500}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Wrong job — please reallocate"
              className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmReject}>
              Reject with reason
            </Button>
          </div>
        </div>
      </Modal>

      {/* #127: mark a missing day as not worked (type + optional note). */}
      <Modal
        open={markTarget !== null}
        onClose={() => setMarkTarget(null)}
        title={
          markTarget
            ? `${markTarget.worker.workerName} — ${dayLabel(markTarget.day)} not worked`
            : "Mark not worked"
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            This records an approved absence for the day, so the week can reach
            payroll-ready. It creates no hours and never counts as worked time.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-text">Type</span>
            <select
              value={markType}
              onChange={(e) => setMarkType(e.target.value)}
              data-testid="mark-type"
              className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            >
              <option value="annual">Annual leave</option>
              <option value="sick">Sick</option>
              <option value="rdo">RDO</option>
              <option value="unpaid">Unpaid</option>
              <option value="other">Other</option>
            </select>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => setMarkTarget(null)} disabled={markBusy}>
              Cancel
            </Button>
            <Button onClick={confirmMark} disabled={markBusy} data-testid="mark-confirm">
              {markBusy ? "Saving…" : "Mark not worked"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={reopenTarget !== null}
        onClose={() => {
          if (reopenBusy) return;
          setReopenTarget(null);
          setReopenBlock(null);
        }}
        title={
          reopenTarget
            ? `Reopen ${reopenTarget.worker.workerName}'s ${dayLabel(reopenTarget.day)}`
            : "Reopen"
        }
      >
        <div className="space-y-4">
          {reopenTarget ? (
            <p className="text-sm text-text-muted">
              {`This ${reopenTarget.day.status} day goes back to ${
                reopenToStatus === "submitted" ? "the approvals queue" : "the worker as a draft"
              }. The worker gets a push either way.`}
            </p>
          ) : null}

          <div role="radiogroup" aria-label="Where does it go" className="space-y-2">
            {(
              [
                ["submitted", "Back to the approvals queue (re-decide it here)"],
                ["draft", "Back to the worker as a draft (they fix and resubmit)"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="reopen-to"
                  checked={reopenToStatus === value}
                  onChange={() => setReopenToStatus(value)}
                />
                {label}
              </label>
            ))}
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-text">Reason (required)</span>
            <textarea
              autoFocus
              rows={3}
              maxLength={500}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g. Approved against the wrong job — needs reallocating"
              className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            />
          </label>

          {reopenBlock ? (
            <div
              role="alert"
              className="rounded-card border border-border border-l-4 border-l-state-danger bg-surface-subtle p-3 text-sm"
            >
              <p className="font-medium text-text">Already in a sent payroll file</p>
              <p className="mt-1 text-text-muted">{reopenBlock}</p>
              <p className="mt-1 text-text-muted">
                Forcing the reopen diverges from the exported file — re-export and tell payroll.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              disabled={reopenBusy}
              onClick={() => {
                setReopenTarget(null);
                setReopenBlock(null);
              }}
            >
              Cancel
            </Button>
            {reopenBlock ? (
              <Button variant="danger" disabled={reopenBusy} onClick={() => void confirmReopen(true)}>
                {reopenBusy ? "Reopening…" : "Reopen anyway (diverges from export)"}
              </Button>
            ) : (
              <Button disabled={reopenBusy} onClick={() => void confirmReopen(false)}>
                {reopenBusy ? "Reopening…" : "Reopen"}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function WeekNavLink({
  week,
  label,
  icon,
}: {
  week: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <Link
      href={{ pathname: HOURS_WEEKLY, query: { week } }}
      aria-label={label}
      title={label}
      className="rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

/** The worker's sub-line: "{N jobs|single job} · {role}". */
function workerSubLine(worker: WeeklyWorkerHours): string {
  const jobs = worker.jobBreakdown;
  const jobPart =
    jobs.length === 0
      ? "No hours yet"
      : jobs.length === 1
        ? jobs[0]!.jobName
        : `${jobs.length} jobs`;
  return worker.workerRole ? `${jobPart} · ${worker.workerRole}` : jobPart;
}

/**
 * One worker's week — the design's per-worker card. Header: name + sub-line
 * on the left; week total, labour $ (admin data — "—" when unrated, never a
 * fake $0) and the status chip on the right. Below: the Mon–Sun strip, the
 * job-split chips (>1 job), the honest "needs a look" reasons, then the
 * submitted days in an inset box with in-place Approve / Reject per day and
 * the bulk "Approve this day"/"Approve all N days" — and any other day that
 * still needs a hand (rejected → Reopen, missing → Mark not worked, leave →
 * Undo). The "Reject" path is the EXISTING reject-with-reason flow — it
 * pushes the reason to the worker's phone; there is no separate non-rejecting
 * "ask" backend, so the row deliberately does not fake a two-way query thread.
 */
function WorkerRow({
  worker,
  action,
  bulkBusy,
  canReopen,
  onApprove,
  onApproveWeek,
  onReopen,
  onReject,
  onMarkNotWorked,
  onUndoLeave,
}: {
  worker: WeeklyWorkerHours;
  action: ActionState;
  bulkBusy: boolean;
  canReopen: boolean;
  onApprove: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onApproveWeek: (worker: WeeklyWorkerHours) => void;
  onReopen: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReject: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onMarkNotWorked: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onUndoLeave: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
}): ReactNode {
  const chip = workerStatusChip(worker);
  const needsLook = worker.needsLookReasons.length > 0;
  const split = worker.jobBreakdown.length > 1;
  const labour = wholeDollarsFromCents(worker.labourCents);

  // Weekend rows only earn their place when something real happened on them.
  const dayRows = worker.days.filter(
    (d) => !(["Sat", "Sun"].includes(d.weekday) && d.entryId === null && d.status !== "missing"),
  );
  const submittedDays = dayRows.filter((d) => d.status === "submitted");
  // Non-submitted days that still need a hand or an explanation — rendered
  // under the inset box. Future / not-required rows carry no decision meaning
  // and stay off the card entirely (the strip already shows them as "·").
  const attentionDays = dayRows.filter(
    (d) =>
      d.status === "rejected" ||
      d.status === "draft" ||
      d.status === "missing" ||
      d.status === "leave" ||
      (d.status === "approved" && canReopen && d.entryId !== null),
  );
  // A flagged week (or one with decisions to make) expands its day detail.
  const expanded = needsLook || worker.submittedCount > 0;

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      {/* Header line — who · total · chip. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[15px] font-semibold text-text">
            {worker.workerName}
          </div>
          <div className="truncate font-mono text-[10px] uppercase tracking-wide text-text-muted">
            {workerSubLine(worker)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="font-mono text-[11px] text-text-muted tabular-nums">
            {labour ?? "—"}
          </span>
          <span className="font-display text-[15px] font-bold text-text tabular-nums">
            {formatHoursLabel(worker.loggedHours)}
          </span>
          <Pill tone={chip.tone}>{chip.label}</Pill>
        </div>
      </div>

      {/* Seven-day strip, Mon → Sun. */}
      <div className="overflow-x-auto">
        <WeekShapeStrip cells={workerStrip(worker)} workerName={worker.workerName} />
      </div>

      {/* Job-split chips — only when the week spans >1 job. */}
      {split ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            Split this week
          </span>
          {worker.jobBreakdown.map((j, i) => (
            <span
              key={j.jobId ?? `internal-${i}`}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs text-text"
            >
              <span className="truncate">{j.jobName}</span>
              <b className="font-semibold tabular-nums">{j.hours}h</b>
            </span>
          ))}
        </div>
      ) : null}

      {/* Needs-a-look reasons — the honest "why" lines, from real signals. */}
      {needsLook ? (
        <ul className="space-y-1">
          {worker.needsLookReasons.map((reason, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-text-muted">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  worker.rejectedCount > 0 ? "bg-state-danger" : "bg-accent-yellow",
                )}
              />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Submitted days — the design's inset decision box. */}
      {submittedDays.length > 0 ? (
        <div className="rounded-card border border-border bg-surface-subtle px-3 pb-2.5 pt-1">
          {submittedDays.map((day) => (
            <SubmittedDayRow
              key={day.date}
              worker={worker}
              day={day}
              action={action}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
          <div className="pt-2.5">
            <Button size="sm" disabled={bulkBusy} onClick={() => onApproveWeek(worker)}>
              {bulkBusy ? "Approving…" : bulkApproveLabel(worker.submittedCount)}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Other days that still need a hand — rejected / draft / missing /
          leave (+ approved with Reopen for admins). */}
      {expanded && attentionDays.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {attentionDays.map((day) => (
            <li key={day.date} className="py-2.5">
              <AttentionDayRow
                worker={worker}
                day={day}
                canReopen={canReopen}
                onReopen={onReopen}
                onMarkNotWorked={onMarkNotWorked}
                onUndoLeave={onUndoLeave}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One submitted day inside the inset box: date · hours (+OT split) · job
 *  allocations · in-place Approve / Reject. */
function SubmittedDayRow({
  worker,
  day,
  action,
  onApprove,
  onReject,
}: {
  worker: WeeklyWorkerHours;
  day: WeeklyHoursDay;
  action: ActionState;
  onApprove: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReject: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
}): ReactNode {
  const key = dayKey(worker.workerId, day.date);
  const approving = action.kind === "approving" && action.key === key;
  const rejecting = action.kind === "rejecting" && action.key === key;
  const busy = approving || rejecting;
  const otLabel =
    day.overtimeHours != null &&
    day.overtimeHours > 0 &&
    day.hours != null &&
    day.ordinaryHours != null
      ? otSplitLabel({
          ordinaryHours: day.ordinaryHours,
          overtimeHours: day.overtimeHours,
          totalHours: day.hours,
        })
      : null;

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border py-2.5 last:border-b-0">
      <span className="min-w-[96px] font-display text-[13.5px] font-semibold text-text">
        {dayLabel(day)}
      </span>
      <span className="font-display text-[13.5px] font-bold text-text tabular-nums">
        {day.hours != null ? formatHoursLabel(day.hours) : "—"}
      </span>
      {otLabel ? <span className="text-xs text-text-muted">({otLabel})</span> : null}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {day.jobLabel && day.jobLabel !== "No job" ? (
          <span className="inline-flex items-center rounded-card border border-border bg-surface px-2 py-0.5 text-xs font-medium text-text">
            {day.jobLabel}
          </span>
        ) : (
          <Pill tone="warning">No job assigned</Pill>
        )}
        {day.leaveType ? (
          <Pill tone="warning" title="Hours were logged on an approved-leave day">
            Logged on leave
          </Pill>
        ) : null}
      </span>
      <span className="flex shrink-0 gap-2">
        <Button size="sm" onClick={() => onApprove(worker, day)} disabled={busy}>
          {approving ? "Approving…" : "Approve"}
        </Button>
        {/* Ghost-red per the replica — the solid danger button is the modal's
            "Reject with reason" confirm. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(worker, day)}
          className="h-11 rounded-card border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-800 hover:border-rose-300 disabled:opacity-60 sm:h-8"
        >
          {rejecting ? "Rejecting…" : "Reject"}
        </button>
      </span>
      {day.note ? (
        <p className="w-full text-xs text-text-muted">Note: {day.note}</p>
      ) : null}
    </div>
  );
}

/** A non-submitted day that still needs a hand: rejected (reason + Reopen),
 *  draft, missing (Mark not worked), leave (Undo), approved (Reopen). */
function AttentionDayRow({
  worker,
  day,
  canReopen,
  onReopen,
  onMarkNotWorked,
  onUndoLeave,
}: {
  worker: WeeklyWorkerHours;
  day: WeeklyHoursDay;
  canReopen: boolean;
  onReopen: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onMarkNotWorked: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onUndoLeave: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
}): ReactNode {
  const DAY_TONE = {
    approved: "success",
    rejected: "danger",
    draft: "warning",
    missing: "warning",
    leave: "info",
  } as const;
  const tone = DAY_TONE[day.status as keyof typeof DAY_TONE] ?? "neutral";

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-14 font-medium text-text">{dayLabel(day)}</span>
          <Pill tone={tone}>{weeklyDayStatusLabel(day.status)}</Pill>
          {day.hours != null ? (
            <span className="text-text-muted">{formatHoursLabel(day.hours)}</span>
          ) : null}
          {day.jobLabel ? <span className="text-text-muted">· {day.jobLabel}</span> : null}
          {day.status === "leave" && day.leaveType ? (
            <span className="text-text-muted">({day.leaveType})</span>
          ) : null}
          {day.status !== "leave" && day.leaveType && day.entryId ? (
            <Pill tone="warning" title="Hours were logged on an approved-leave day">
              Logged on leave
            </Pill>
          ) : null}
          {day.status === "approved" && day.exportId ? (
            <Pill tone="neutral" title={`Payroll run ${day.exportId}`}>
              Exported
            </Pill>
          ) : null}
          {day.status === "rejected" ? (
            <span className="text-xs text-text-muted">Waiting for worker</span>
          ) : null}
        </div>
        {day.status === "rejected" && day.rejectedReason ? (
          <p className="mt-1 text-xs text-state-danger">{`Reason: ${day.rejectedReason}`}</p>
        ) : null}
        {day.note ? <p className="mt-1 text-xs text-text-muted">Note: {day.note}</p> : null}
      </div>

      {(day.status === "approved" || day.status === "rejected") && canReopen && day.entryId ? (
        <div className="flex gap-2 sm:justify-end">
          <Button size="sm" variant="ghost" onClick={() => onReopen(worker, day)}>
            Reopen
          </Button>
        </div>
      ) : day.status === "missing" ? (
        <div className="flex gap-2 sm:justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMarkNotWorked(worker, day)}
            data-testid="mark-not-worked"
          >
            Mark not worked
          </Button>
        </div>
      ) : day.status === "leave" ? (
        <div className="flex gap-2 sm:justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUndoLeave(worker, day)}
            data-testid="undo-not-worked"
          >
            Undo
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ActionFeedback({ state }: { state: ActionState }): ReactNode {
  if (state.kind === "success") {
    return (
      <Card className="border-emerald-200 bg-emerald-50" role="status" aria-live="polite">
        <CardDescription className="text-emerald-900">{state.label}</CardDescription>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="border-rose-200 bg-rose-50" role="alert" aria-live="assertive">
        <CardDescription className="text-rose-900">{state.message}</CardDescription>
      </Card>
    );
  }
  return null;
}
