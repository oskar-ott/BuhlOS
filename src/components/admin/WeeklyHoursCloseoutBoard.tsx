"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { timesheetsClient } from "@/domains/timesheets/client";
import { requestLeave, clearLeave } from "@/domains/timesheets/client";
import { formatHoursLabel, otSplitLabel } from "@/domains/timesheets/format";
import {
  readinessLabel,
  submittedWeekSelection,
  weeklyDayStatusLabel,
  type WeeklyHoursCloseout,
  type WeeklyHoursDay,
  type WeeklyWorkerHours,
  type WorkerWeekReadiness,
  type WeeklyDayStatus,
} from "@/domains/timesheets/weekly-closeout";
import {
  buildPayRun,
  workerStrip,
  wholeDollarsFromCents,
  type StripTone,
} from "@/domains/timesheets/pay-run";
import { WeekShapeStrip, WeekShapeLegend } from "@/components/admin/WeekShapeStrip";

/** Job-split chip dot palette — a small fixed set of brand-token classes,
 *  indexed by the chip's position so each job gets a stable colour without an
 *  inline style (the repo bans the `style` attribute, so the mockup's per-dot
 *  inline colours are mapped to token classes here). */
const SPLIT_DOT_CLASSES = [
  "bg-brand-navy",
  "bg-state-success",
  "bg-accent-yellow",
  "bg-state-info",
  "bg-state-danger",
] as const;

function splitDotClass(index: number): string {
  return SPLIT_DOT_CLASSES[index % SPLIT_DOT_CLASSES.length]!;
}

/**
 * The interactive part of /hours/weekly. The server component fetches one
 * week of /api/time-entries-overview, derives the closeout model
 * (buildWeeklyHoursCloseout) and passes it in; this component renders the
 * decision-first board and fires the SAME approve / reject endpoints the
 * approvals queue uses (timesheetsClient) — no second status-transition
 * implementation. After every action it refreshes the route so the model is
 * rebuilt from persisted state, never locally guessed.
 *
 * Lives in src/components/admin/ (not next to the page) for the same
 * Next.js 15.5 React Client Manifest bug that bit /hours/approvals — see
 * HoursApprovalsQueue.tsx for the digest.
 */

interface WeeklyHoursCloseoutBoardProps {
  closeout: WeeklyHoursCloseout;
  fetchError: string | null;
  /** True when the viewer can undo (reopen is admin-tier; leading hands
   *  approve but cannot reopen, so they never see a button that would 403). */
  canUndo?: boolean;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "approving"; key: string }
  | { kind: "rejecting"; key: string }
  | { kind: "success"; label: string }
  | { kind: "error"; message: string };

/** Result of one "Approve week" call — per-day truth, never a rollup lie. */
interface BulkOutcome {
  workerName: string;
  approvedCount: number;
  failed: Array<{ date: string | null; error: string }>;
  /** Entries the viewer can still revert (cleared when the 30s window ends). */
  undo: Array<{ userId: string; date: string }>;
}

const READINESS_TONE: Record<WorkerWeekReadiness, "info" | "warning" | "success" | "danger"> = {
  "payroll-ready": "success",
  "needs-review": "info",
  "needs-worker": "danger",
  "missing-hours": "warning",
};

const DAY_TONE: Record<WeeklyDayStatus, "neutral" | "info" | "success" | "danger" | "warning"> = {
  approved: "success",
  submitted: "info",
  rejected: "danger",
  draft: "warning",
  missing: "warning",
  leave: "info",
  holiday: "neutral",
  future: "neutral",
  "not-required": "neutral",
};

function dayKey(workerId: string, date: string): string {
  return `${workerId}:${date}`;
}

/** "Mon 8" — board row label, UTC-parsed like the Phil strip. */
function dayLabel(day: WeeklyHoursDay): string {
  const num = new Date(day.date + "T00:00:00Z").toLocaleDateString("en-AU", {
    day: "numeric",
    timeZone: "UTC",
  });
  return `${day.weekday} ${num}`;
}

export function WeeklyHoursCloseoutBoard({
  closeout,
  fetchError,
  canUndo = false,
}: WeeklyHoursCloseoutBoardProps) {
  const router = useRouter();
  const payRun = buildPayRun(closeout);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [bulk, setBulk] = useState<BulkOutcome | null>(null);
  const [bulkBusyWorker, setBulkBusyWorker] = useState<string | null>(null);
  // "Approve all clean" runs across workers, so it is tracked separately from
  // the per-worker "Approve week" busy flag.
  const [cleanSweepBusy, setCleanSweepBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  // Monotonic id so a stale 30s timer never clears a NEWER bulk result.
  const bulkSeqRef = useRef(0);
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
   * endpoint and outcome surface as the per-worker "Approve week".
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

      <PayRunHero
        closeout={closeout}
        payRun={payRun}
        cleanSweepBusy={cleanSweepBusy}
        onApproveAllClean={approveAllClean}
      />

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
          {/* §5 mockup `hwk-list card` — one dense row per worker per week, the
              flagged ones first (the model already sorts needs-action → ready).
              Each row shows the seven-day NUMBER strip, the weekly total + labour
              $, and a per-worker action; flagged weeks expand the reasons + the
              per-day approve / reject controls. */}
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

          <p className="text-xs text-text-muted">
            Approving a week sends it to the payroll export below. Workers can
            still see their hours in Phil; only the office approves. Rejecting a
            day bounces it back to the worker on Phil with your reason.
          </p>
        </>
      )}

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

/**
 * Progress-bar fill width as a STATIC Tailwind class (no inline style — the
 * repo bans the `style` attribute). Rounded to the nearest 10% bucket so the
 * class name is statically resolvable; the precise "X of Y" count sits beside
 * the bar, so this approximation never misleads. Mirrors the approach in
 * OnboardingProgress.
 */
function progressFillClass(pct: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  if (clamped <= 0) return "w-0";
  if (clamped >= 100) return "w-full";
  const bucket = Math.round(clamped / 10) * 10;
  switch (bucket) {
    case 10:
      return "w-[10%]";
    case 20:
      return "w-1/5";
    case 30:
      return "w-[30%]";
    case 40:
      return "w-2/5";
    case 50:
      return "w-1/2";
    case 60:
      return "w-3/5";
    case 70:
      return "w-[70%]";
    case 80:
      return "w-4/5";
    case 90:
      return "w-[90%]";
    default:
      return "w-1/2";
  }
}

/**
 * The pay-run hero (§5 mockup `hrs-payday`) — the office's "this week's run"
 * banner. Eyebrow "Pay run · {payday}", a "{Week} ready to approve" headline,
 * a meta line — "{totalHrs}h logged · ${labour} labour · {crew} crew ·
 * {needLook} need a look" — a progress bar "{approved} of {total} approved",
 * and the one always-safe bulk action: "Approve all clean · {n}". Flagged
 * weeks (rejected / draft / missing) are excluded from the sweep.
 *
 * MONEY: /hours is admin-tier, so the §5 labour figure is correct here. It sums
 * ONLY rated workers; when NO worker has a cost rate (e.g. a leading-hand
 * viewer, or rates simply unset) the labour cell is omitted — never "$0".
 */
function PayRunHero({
  closeout,
  payRun,
  cleanSweepBusy,
  onApproveAllClean,
}: {
  closeout: WeeklyHoursCloseout;
  payRun: ReturnType<typeof buildPayRun>;
  cleanSweepBusy: boolean;
  onApproveAllClean: () => void;
}): ReactNode {
  const s = closeout.summary;
  const h = payRun.hero;
  const cleanCount = payRun.cleanWorkerCount;

  return (
    <Card className="space-y-4 border-l-4 border-l-brand-navy">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Left — eyebrow, headline, the meta line. */}
        <div className="min-w-0 space-y-1">
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">
            Pay run · {h.rangeLabel}
          </p>
          <CardTitle>
            {h.crewCount === 0
              ? "No hours to approve this week"
              : h.allReady
                ? "This week is approved"
                : `${h.crewCount} ${h.crewCount === 1 ? "week" : "weeks"} ready to approve`}
          </CardTitle>
          {h.crewCount > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
              <span>
                <b className="font-semibold text-text tabular-nums">{h.loggedHoursShort}h</b>{" "}
                logged
              </span>
              {h.labourLabel ? (
                <span>
                  <span aria-hidden="true">· </span>
                  <b className="font-semibold text-text tabular-nums">{h.labourLabel}</b> labour
                </span>
              ) : null}
              <span>
                <span aria-hidden="true">· </span>
                <b className="font-semibold text-text tabular-nums">{h.crewCount}</b>{" "}
                {h.crewCount === 1 ? "worker" : "crew"}
              </span>
              <span className={h.needLookCount > 0 ? "text-state-danger" : undefined}>
                <span aria-hidden="true">· </span>
                <b
                  className={cn(
                    "font-semibold tabular-nums",
                    h.needLookCount > 0 ? "text-state-danger" : "text-text",
                  )}
                >
                  {h.needLookCount}
                </b>{" "}
                need a look
              </span>
            </div>
          ) : null}
        </div>

        {/* Right — progress + the primary sweep action. */}
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <div className="w-full space-y-1 sm:w-52">
            <div
              className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-subtle"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={h.progressPct}
              aria-label="Workers approved this week"
            >
              <div
                aria-hidden="true"
                className={cn(
                  "h-full rounded-pill bg-accent-yellow transition-[width]",
                  progressFillClass(h.progressPct),
                )}
              />
            </div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
              {`${h.readyCount} of ${h.crewCount} approved`}
            </p>
          </div>
          {h.allReady ? (
            <Button disabled>All approved</Button>
          ) : cleanCount > 0 ? (
            <Button onClick={onApproveAllClean} disabled={cleanSweepBusy}>
              {cleanSweepBusy
                ? "Approving clean weeks…"
                : `Approve all clean · ${cleanCount}`}
            </Button>
          ) : h.crewCount > 0 ? (
            <Button disabled>Clean weeks done — clear the flags</Button>
          ) : null}
        </div>
      </div>

      <p className="border-t border-border pt-3 text-sm text-text-muted">
        <span className="font-display text-lg font-semibold text-text tabular-nums">
          {formatHoursLabel(s.approvedHours)}
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
    </Card>
  );
}

/** Initials avatar — token-coloured, tints amber for a flagged week and green
 *  for a ready one (the mockup's `Avatar tone`). No image dependency. */
function WorkerAvatar({
  name,
  tone,
}: {
  name: string;
  tone: "ready" | "look" | "neutral";
}): ReactNode {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  const toneClass =
    tone === "ready"
      ? "bg-emerald-100 text-emerald-800"
      : tone === "look"
        ? "bg-amber-100 text-amber-900"
        : "bg-surface-subtle text-text-muted";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xs font-semibold",
        toneClass,
      )}
    >
      {initials || "—"}
    </span>
  );
}

/** The worker's sub-line: "{N jobs|single job} · {role}" — the mockup `hwk-sub`. */
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
 * One worker's week — the §5 mockup `hwk` row. A four-part main line: who
 * (avatar + name + sub), the seven-day NUMBER strip, the weekly total + labour
 * $, and a per-worker action. A clean week shows "Approve week"; a flagged
 * ("needs a look") week shows a pill + the reason lines + "Reject…" +
 * "Approve anyway". A week spanning >1 job shows "Split this week" + a chip per
 * job. Flagged weeks also expand the per-day approve / reject controls (the
 * day-level decisions the office still makes).
 *
 * The "Reject…" path is the EXISTING reject-with-reason flow — it pushes the
 * reason to the worker on Phil. There is no separate non-rejecting "ask"
 * backend, so the row deliberately does not fake a two-way query thread.
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
  const ready = worker.readiness === "payroll-ready";
  const needsLook = worker.needsLookReasons.length > 0;
  const tone: "ready" | "look" | "neutral" = ready ? "ready" : needsLook ? "look" : "neutral";
  const split = worker.jobBreakdown.length > 1;

  // Weekend rows only earn their place when something real happened on them.
  const dayRows = worker.days.filter(
    (d) => !(["Sat", "Sun"].includes(d.weekday) && d.entryId === null && d.status !== "missing"),
  );
  // A flagged week with day-level decisions to make expands its per-day rows.
  const showDayRows = needsLook || worker.submittedCount > 0;

  const rowBg = ready ? "bg-emerald-50/40" : needsLook ? "bg-amber-50/40" : undefined;

  return (
    <div className={cn("px-4 py-3.5", rowBg)}>
      {/* Main line — who · strip · total+$ · action. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-5">
        {/* Who. */}
        <div className="flex min-w-0 items-center gap-3 lg:w-56 lg:shrink-0">
          <WorkerAvatar name={worker.workerName} tone={tone} />
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-bold text-text">
              {worker.workerName}
            </div>
            <div className="truncate font-mono text-[10px] uppercase tracking-wide text-text-muted">
              {workerSubLine(worker)}
            </div>
          </div>
        </div>

        {/* Seven-day NUMBER strip. */}
        <div className={cn("lg:flex-1", ready ? "opacity-60" : undefined)}>
          <WeekShapeStrip cells={workerStrip(worker)} workerName={worker.workerName} />
        </div>

        {/* Weekly total + labour $. */}
        <div className="lg:w-24 lg:shrink-0 lg:text-right">
          <div className="font-display text-xl font-bold leading-none text-text tabular-nums">
            {worker.loggedHours}
            <span className="ml-0.5 text-xs font-semibold text-text-muted">h</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-muted tabular-nums">
            {wholeDollarsFromCents(worker.labourCents) ?? "—"}
          </div>
        </div>

        {/* Per-worker action. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:w-44 lg:justify-end">
          {ready ? (
            <Pill tone="success">Approved</Pill>
          ) : needsLook ? (
            <>
              <Pill tone={worker.rejectedCount > 0 ? "danger" : "warning"}>needs a look</Pill>
              {worker.submittedCount > 0 ? (
                <Button size="sm" disabled={bulkBusy} onClick={() => onApproveWeek(worker)}>
                  {bulkBusy ? "Approving…" : "Approve anyway"}
                </Button>
              ) : null}
            </>
          ) : worker.submittedCount > 0 ? (
            <Button size="sm" disabled={bulkBusy} onClick={() => onApproveWeek(worker)}>
              {bulkBusy ? "Approving week…" : `Approve week (${worker.submittedCount})`}
            </Button>
          ) : (
            <Pill tone={READINESS_TONE[worker.readiness]}>{readinessLabel(worker.readiness)}</Pill>
          )}
        </div>
      </div>

      {/* Job-split chips — only when the week spans >1 job. */}
      {split ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-0 lg:pl-[3.75rem]">
          <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            Split this week
          </span>
          {worker.jobBreakdown.map((j, i) => (
            <span
              key={j.jobId ?? `internal-${i}`}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs text-text"
            >
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", splitDotClass(i))}
              />
              <span className="truncate">{j.jobName}</span>
              <b className="font-semibold tabular-nums">{j.hours}h</b>
              {wholeDollarsFromCents(
                worker.costRateCents != null
                  ? Math.round(j.hours * worker.costRateCents)
                  : null,
              ) ? (
                <span className="font-mono text-text-muted tabular-nums">
                  {wholeDollarsFromCents(
                    worker.costRateCents != null
                      ? Math.round(j.hours * worker.costRateCents)
                      : null,
                  )}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {/* Needs-a-look reasons — the honest "why" lines, from real signals. */}
      {needsLook ? (
        <ul className="mt-3 space-y-1 pl-0 lg:pl-[3.75rem]">
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

      {/* Expanded per-day controls — the day-level approve / reject / reopen /
          mark-not-worked decisions for a flagged or pending week. */}
      {showDayRows ? (
        <ul className="mt-3 divide-y divide-border border-t border-border pl-0 lg:pl-[3.75rem]">
          {dayRows.map((day) => (
            <li key={day.date} className="py-2.5">
              <DayRow
                worker={worker}
                day={day}
                action={action}
                canReopen={canReopen}
                onApprove={onApprove}
                onReopen={onReopen}
                onReject={onReject}
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

function DayRow({
  worker,
  day,
  action,
  canReopen,
  onApprove,
  onReopen,
  onReject,
  onMarkNotWorked,
  onUndoLeave,
}: {
  worker: WeeklyWorkerHours;
  day: WeeklyHoursDay;
  action: ActionState;
  canReopen: boolean;
  onApprove: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReopen: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReject: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onMarkNotWorked: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onUndoLeave: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
}): ReactNode {
  const key = dayKey(worker.workerId, day.date);
  const approving = action.kind === "approving" && action.key === key;
  const rejecting = action.kind === "rejecting" && action.key === key;
  const busy = approving || rejecting;
  const quiet = day.status === "future" || day.status === "not-required";

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className={quiet ? "opacity-50" : undefined}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-14 font-medium text-text">{dayLabel(day)}</span>
          {quiet ? (
            <span className="text-text-muted">—</span>
          ) : (
            <Pill tone={DAY_TONE[day.status]}>{weeklyDayStatusLabel(day.status)}</Pill>
          )}
          {day.hours != null ? (
            <span className="text-text-muted">{formatHoursLabel(day.hours)}</span>
          ) : null}
          {/* #130: base/OT split, only when the day carries BOTH stored split
              fields — never re-derived client-side, so the presenter's honesty
              guard (ordinary+OT must reconcile to total) can still catch
              garbage. ≤8h / unsplit days render byte-identical (the Phil
              presenter applies the same `ordinaryHours != null` gate). */}
          {day.overtimeHours != null && day.overtimeHours > 0 && day.hours != null && day.ordinaryHours != null
            ? (() => {
                const split = otSplitLabel({
                  ordinaryHours: day.ordinaryHours,
                  overtimeHours: day.overtimeHours,
                  totalHours: day.hours,
                });
                return split ? (
                  <span className="text-xs text-text-muted">({split})</span>
                ) : null;
              })()
            : null}
          {day.jobLabel ? <span className="text-text-muted">· {day.jobLabel}</span> : null}
          {day.status === "leave" && day.leaveType ? (
            <span className="text-text-muted">({day.leaveType})</span>
          ) : null}
          {/* #137: name the holiday so the cell says WHY it isn't missing. */}
          {day.status === "holiday" && day.holidayName ? (
            <span className="text-text-muted">({day.holidayName})</span>
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

      {day.status === "submitted" ? (
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button size="sm" onClick={() => onApprove(worker, day)} disabled={busy}>
            {approving ? "Approving…" : "Approve"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onReject(worker, day)} disabled={busy}>
            {rejecting ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      ) : (day.status === "approved" || day.status === "rejected") && canReopen && day.entryId ? (
        <div className="flex gap-2 sm:justify-end">
          <Button size="sm" variant="ghost" onClick={() => onReopen(worker, day)} disabled={busy}>
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
