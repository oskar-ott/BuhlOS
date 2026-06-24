"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { timesheetsClient } from "@/domains/timesheets/client";
import { requestLeave, clearLeave } from "@/domains/timesheets/client";
import { formatHoursLabel } from "@/domains/timesheets/format";
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

/** "3 approved · 1 submitted · 1 missing" — only non-zero parts. */
function countLine(w: WeeklyWorkerHours): string {
  const parts: string[] = [];
  if (w.approvedCount) parts.push(`${w.approvedCount} approved`);
  if (w.submittedCount) parts.push(`${w.submittedCount} submitted`);
  if (w.rejectedCount) parts.push(`${w.rejectedCount} rejected`);
  if (w.draftCount) parts.push(`${w.draftCount} draft`);
  if (w.missingCount) parts.push(`${w.missingCount} missing`);
  return parts.join(" · ") || "no entries";
}

export function WeeklyHoursCloseoutBoard({
  closeout,
  fetchError,
  canUndo = false,
}: WeeklyHoursCloseoutBoardProps) {
  const router = useRouter();
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [bulk, setBulk] = useState<BulkOutcome | null>(null);
  const [bulkBusyWorker, setBulkBusyWorker] = useState<string | null>(null);
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

  const needAction = closeout.workers.filter((w) => w.readiness !== "payroll-ready");
  const ready = closeout.workers.filter((w) => w.readiness === "payroll-ready");

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

      <SummaryCard closeout={closeout} />

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
          <section aria-label="Workers needing action">
            <SectionHeading
              title="Needs action"
              count={needAction.length}
              tone="warning"
            />
            {needAction.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                Nothing blocking — everyone with hours this week is payroll-ready.
              </p>
            ) : (
              <ul className="mt-2 space-y-3">
                {needAction.map((w) => (
                  <li key={w.workerId}>
                    <WorkerCard
                      worker={w}
                      action={action}
                      defaultOpen={needAction.length <= 3}
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
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Workers ready for payroll">
            <SectionHeading title="Ready for payroll" count={ready.length} tone="success" />
            {ready.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">
                No one is fully payroll-ready yet for this week.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {ready.map((w) => (
                  <li key={w.workerId}>
                    <Card className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <span className="font-medium text-text">{w.workerName}</span>
                        <span className="ml-2 text-sm text-text-muted">
                          {`${w.approvedCount} approved · ${formatHoursLabel(w.approvedHours)}`}
                        </span>
                      </div>
                      <Pill tone="success">Ready</Pill>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
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

function SummaryCard({ closeout }: { closeout: WeeklyHoursCloseout }): ReactNode {
  const s = closeout.summary;
  return (
    <Card className="space-y-3 border-l-4 border-l-brand-navy">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Payroll readiness</CardTitle>
        <Pill tone={s.payrollReady ? "success" : "warning"}>
          {s.payrollReady ? "Payroll-ready" : "Not payroll-ready"}
        </Pill>
      </div>

      {/* single strings per pill — adjacent JSX text would be split by SSR
          comment markers and break copy/tests */}
      <div className="flex flex-wrap gap-2">
        <Pill tone="success">{`${s.workersReady} ready`}</Pill>
        <Pill tone={s.workersNeedAction > 0 ? "warning" : "neutral"}>
          {`${s.workersNeedAction} need action`}
        </Pill>
        {s.submittedDays > 0 ? (
          <Pill tone="info">
            {`${s.submittedDays} submitted ${s.submittedDays === 1 ? "day" : "days"}`}
          </Pill>
        ) : null}
        {s.rejectedDays > 0 ? (
          <Pill tone="danger">{`${s.rejectedDays} rejected`}</Pill>
        ) : null}
        {s.draftDays > 0 ? <Pill tone="warning">{`${s.draftDays} draft`}</Pill> : null}
        {s.missingDays > 0 ? (
          <Pill tone="warning">
            {`${s.missingDays} missing ${s.missingDays === 1 ? "day" : "days"}`}
          </Pill>
        ) : null}
      </div>

      <p className="text-sm text-text-muted">
        <span className="font-display text-xl font-semibold text-text">
          {formatHoursLabel(s.approvedHours)}
        </span>{" "}
        approved this week
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

function SectionHeading({
  title,
  count,
  tone,
}: {
  title: string;
  count: number;
  tone: "warning" | "success";
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <h2 className="font-display text-sm font-semibold uppercase tracking-widest text-text-muted">
        {title}
      </h2>
      <Pill tone={count > 0 ? tone : "neutral"}>{count}</Pill>
    </div>
  );
}

function WorkerCard({
  worker,
  action,
  defaultOpen,
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
  defaultOpen: boolean;
  bulkBusy: boolean;
  canReopen: boolean;
  onApprove: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onApproveWeek: (worker: WeeklyWorkerHours) => void;
  onReopen: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReject: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onMarkNotWorked: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onUndoLeave: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
}): ReactNode {
  // Weekend rows only earn their place when something real happened on them.
  const days = worker.days.filter(
    (d) => !(["Sat", "Sun"].includes(d.weekday) && d.entryId === null && d.status !== "missing")
  );
  return (
    <Card className="space-y-3">
      <details open={defaultOpen}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <CardTitle>{worker.workerName}</CardTitle>
            <CardDescription>{countLine(worker)}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {worker.submittedCount > 0 ? (
              <Button
                size="sm"
                disabled={bulkBusy}
                onClick={(e) => {
                  // The button lives inside <summary> — stop the click from
                  // toggling the disclosure.
                  e.preventDefault();
                  e.stopPropagation();
                  onApproveWeek(worker);
                }}
              >
                {bulkBusy
                  ? "Approving week…"
                  : `Approve week (${worker.submittedCount})`}
              </Button>
            ) : null}
            <Pill tone={READINESS_TONE[worker.readiness]}>{readinessLabel(worker.readiness)}</Pill>
          </div>
        </summary>

        <ul className="mt-3 divide-y divide-border border-t border-border">
          {days.map((day) => (
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

        {worker.blockers.length > 0 ? (
          <p className="mt-3 text-xs text-text-muted">
            <span className="font-medium text-text">Blocking payroll:</span>{" "}
            {worker.blockers.join(" · ")}
          </p>
        ) : null}
      </details>
    </Card>
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
