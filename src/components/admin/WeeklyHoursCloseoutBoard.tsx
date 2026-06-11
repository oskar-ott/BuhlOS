"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { timesheetsClient } from "@/domains/timesheets/client";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  readinessLabel,
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
}

type ActionState =
  | { kind: "idle" }
  | { kind: "approving"; key: string }
  | { kind: "rejecting"; key: string }
  | { kind: "success"; label: string }
  | { kind: "error"; message: string };

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

export function WeeklyHoursCloseoutBoard({ closeout, fetchError }: WeeklyHoursCloseoutBoardProps) {
  const router = useRouter();
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [rejectTarget, setRejectTarget] = useState<{
    worker: WeeklyWorkerHours;
    day: WeeklyHoursDay;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [, startTransition] = useTransition();

  const needAction = closeout.workers.filter((w) => w.readiness !== "payroll-ready");
  const ready = closeout.workers.filter((w) => w.readiness === "payroll-ready");

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
                      onApprove={approve}
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
  onApprove,
  onReject,
}: {
  worker: WeeklyWorkerHours;
  action: ActionState;
  defaultOpen: boolean;
  onApprove: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
  onReject: (worker: WeeklyWorkerHours, day: WeeklyHoursDay) => void;
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
          <Pill tone={READINESS_TONE[worker.readiness]}>{readinessLabel(worker.readiness)}</Pill>
        </summary>

        <ul className="mt-3 divide-y divide-border border-t border-border">
          {days.map((day) => (
            <li key={day.date} className="py-2.5">
              <DayRow worker={worker} day={day} action={action} onApprove={onApprove} onReject={onReject} />
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
        <div className="flex gap-2 sm:justify-end">
          <Button size="sm" onClick={() => onApprove(worker, day)} disabled={busy}>
            {approving ? "Approving…" : "Approve"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onReject(worker, day)} disabled={busy}>
            {rejecting ? "Rejecting…" : "Reject"}
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
