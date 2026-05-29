"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { relativeWhen } from "@/domains/jobs/format";
import { timesheetsClient } from "@/domains/timesheets/client";
import {
  formatDateLabel,
  formatHoursLabel,
  formatTimestamp,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import type { TimeEntry } from "@/domains/timesheets/types";

interface HoursApprovalsQueueProps {
  initialEntries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "approving"; entryKey: string }
  | { kind: "rejecting"; entryKey: string }
  | { kind: "success"; entryKey: string; label: string }
  | { kind: "error"; message: string };

function entryKey(entry: Pick<TimeEntry, "userId" | "date">): string {
  return `${entry.userId}:${entry.date}`;
}

/**
 * The interactive part of /hours/approvals. Server component fetches the
 * queue + passes it in; this component handles approve / reject mutations,
 * tracks per-row in-flight state, and refreshes the page after every action.
 *
 * Lives in src/components/admin/ rather than next to the page in the
 * (admin)/hours/approvals/ route folder because Next.js 15.5's RSC
 * bundler has a known bug where a deep-nested sibling client component
 * (route group → segment → child segment → client) can be omitted from
 * the page's React Client Manifest. SSR then throws "Could not find the
 * module …#ApprovalsClient in the React Client Manifest" with digest
 * 292479990. /gear works because it's only one route segment deep;
 * /hours/approvals is two and hits the bug. See PR #6.
 */
export function HoursApprovalsQueue({ initialEntries, fetchError }: HoursApprovalsQueueProps) {
  const router = useRouter();
  const [entries, setEntries] = useState<ReadonlyArray<TimeEntry>>(initialEntries);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [rejectTarget, setRejectTarget] = useState<TimeEntry | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [, startTransition] = useTransition();

  const grouped = useMemo(() => groupByWorker(entries), [entries]);

  async function approve(entry: TimeEntry) {
    const key = entryKey(entry);
    setAction({ kind: "approving", entryKey: key });
    const result = await timesheetsClient.approveEntry({
      userId: entry.userId,
      date: entry.date,
    });
    if (result.ok) {
      setEntries((current) => current.filter((e) => entryKey(e) !== key));
      setAction({
        kind: "success",
        entryKey: key,
        label: `Approved ${formatHoursLabel(entry.totalHours)} for ${entry.userName ?? entry.userId} on ${entry.date}`,
      });
      // Re-fetch on the server so the overview counts refresh next visit.
      startTransition(() => router.refresh());
      return;
    }
    setAction({
      kind: "error",
      message:
        result.error.status === 403
          ? "You don't have permission to approve this entry — admin only."
          : result.error.message || "Couldn't approve. Try again.",
    });
  }

  function openReject(entry: TimeEntry) {
    setRejectTarget(entry);
    setRejectReason("");
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    const trimmed = rejectReason.trim();
    if (!trimmed) {
      setAction({ kind: "error", message: "Rejection reason is required." });
      return;
    }
    const key = entryKey(rejectTarget);
    setAction({ kind: "rejecting", entryKey: key });
    setRejectTarget(null);
    const result = await timesheetsClient.rejectEntry({
      userId: rejectTarget.userId,
      date: rejectTarget.date,
      reason: trimmed,
    });
    if (result.ok) {
      setEntries((current) => current.filter((e) => entryKey(e) !== key));
      setAction({
        kind: "success",
        entryKey: key,
        label: `Rejected ${rejectTarget.userName ?? rejectTarget.userId}'s ${rejectTarget.date}. They'll get a push notification with the reason.`,
      });
      startTransition(() => router.refresh());
      return;
    }
    setAction({
      kind: "error",
      message:
        result.error.status === 403
          ? "You don't have permission to reject this entry — admin only."
          : result.error.message || "Couldn't reject. Try again.",
    });
  }

  return (
    <div className="space-y-4">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the queue</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. Approvals are unavailable until the API responds again.
          </CardDescription>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      <ActionFeedback state={action} />

      {entries.length === 0 ? (
        <EmptyState
          title="No entries to approve"
          description="When workers submit hours from /phil/my-day they'll show up here grouped by worker. Leading hands only see entries on their own jobs."
        />
      ) : (
        <ul className="space-y-4">
          {grouped.map((group) => (
            <li key={group.userId}>
              <WorkerGroup
                group={group}
                action={action}
                onApprove={approve}
                onReject={openReject}
              />
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={rejectTarget !== null}
        onClose={() => {
          setRejectTarget(null);
          setRejectReason("");
        }}
        title={
          rejectTarget ? `Reject ${rejectTarget.userName ?? rejectTarget.userId}'s hours` : "Reject"
        }
      >
        <div className="space-y-4">
          {rejectTarget ? (
            <p className="text-sm text-text-muted">
              {formatHoursLabel(rejectTarget.totalHours)} on{" "}
              <span className="font-medium text-text">{formatDateLabel(rejectTarget.date)}</span>.
              The reason is shared with the worker in a push notification.
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
              placeholder="e.g. Wrong job — please reallocate to IV-3232"
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

function ActionFeedback({ state }: { state: ActionState }) {
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

interface WorkerGroupShape {
  userId: string;
  userName: string;
  userRole: string | null;
  totalHours: number;
  entries: ReadonlyArray<TimeEntry>;
  /** Earliest submission in the group (comparable ISO). Drives the
   *  exception-first sort + the "waiting since" label. */
  oldestSubmittedAt: string;
}

/** Comparable timestamp for an entry — its submission time, or the work
 *  date at midnight if the API didn't stamp submittedAt. */
function entryWaitTs(e: TimeEntry): string {
  return e.submittedAt ?? `${e.date}T00:00:00.000Z`;
}

function groupByWorker(entries: ReadonlyArray<TimeEntry>): ReadonlyArray<WorkerGroupShape> {
  const map = new Map<string, WorkerGroupShape>();
  for (const e of entries) {
    const key = e.userId;
    const ts = entryWaitTs(e);
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        totalHours: existing.totalHours + e.totalHours,
        entries: [...existing.entries, e],
        oldestSubmittedAt:
          ts < existing.oldestSubmittedAt ? ts : existing.oldestSubmittedAt,
      });
    } else {
      map.set(key, {
        userId: e.userId,
        userName: e.userName ?? e.userId,
        userRole: e.userRole ?? null,
        totalHours: e.totalHours,
        entries: [e],
        oldestSubmittedAt: ts,
      });
    }
  }
  // Exception-first: the worker who has been waiting longest sits at the
  // top, so the owner clears the most-overdue timesheets first. Name is
  // only a tiebreaker when two workers submitted at the same instant.
  return Array.from(map.values()).sort((a, b) => {
    if (a.oldestSubmittedAt !== b.oldestSubmittedAt) {
      return a.oldestSubmittedAt < b.oldestSubmittedAt ? -1 : 1;
    }
    return a.userName.localeCompare(b.userName);
  });
}

function WorkerGroup({
  group,
  action,
  onApprove,
  onReject,
}: {
  group: WorkerGroupShape;
  action: ActionState;
  onApprove: (entry: TimeEntry) => void;
  onReject: (entry: TimeEntry) => void;
}): ReactNode {
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <CardTitle>{group.userName}</CardTitle>
          <CardDescription>
            {group.userRole ? <span className="capitalize">{group.userRole}</span> : "Worker"} ·{" "}
            {formatHoursLabel(group.totalHours)} across {group.entries.length} entries
          </CardDescription>
          <p className="mt-0.5 text-xs text-text-muted">
            Oldest {relativeWhen(group.oldestSubmittedAt)}
          </p>
        </div>
        <Pill tone="info">{group.entries.length}</Pill>
      </div>

      <ul className="divide-y divide-border">
        {group.entries
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((entry) => (
            <li key={entry.id} className="py-3">
              <EntryRow entry={entry} action={action} onApprove={onApprove} onReject={onReject} />
            </li>
          ))}
      </ul>
    </Card>
  );
}

function EntryRow({
  entry,
  action,
  onApprove,
  onReject,
}: {
  entry: TimeEntry;
  action: ActionState;
  onApprove: (entry: TimeEntry) => void;
  onReject: (entry: TimeEntry) => void;
}): ReactNode {
  const key = entryKey(entry);
  const approving = action.kind === "approving" && action.entryKey === key;
  const rejecting = action.kind === "rejecting" && action.entryKey === key;
  const busy = approving || rejecting;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-text">{formatDateLabel(entry.date)}</span>
          <Pill tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Pill>
          <span className="text-text-muted">{formatHoursLabel(entry.totalHours)}</span>
        </div>
        {entry.notes ? (
          <p className="text-sm text-text-muted">
            <span className="font-medium text-text">Note:</span> {entry.notes}
          </p>
        ) : null}
        <AllocationLine entry={entry} />
        <p className="text-xs text-text-muted">
          Submitted {formatTimestamp(entry.submittedAt) ?? "—"}
          {entry.enteredByName && entry.source !== "self"
            ? ` · entered by ${entry.enteredByName}`
            : ""}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:items-end">
        <Button onClick={() => onApprove(entry)} disabled={busy}>
          {approving ? "Approving…" : "Approve"}
        </Button>
        <Button variant="danger" onClick={() => onReject(entry)} disabled={busy}>
          {rejecting ? "Rejecting…" : "Reject"}
        </Button>
      </div>
    </div>
  );
}

function AllocationLine({ entry }: { entry: TimeEntry }): ReactNode {
  if (!entry.allocations || entry.allocations.length === 0) return null;
  const labels = entry.allocations.map((a, i) => {
    const job = (a.jobName as string | null | undefined) ?? a.jobId ?? "no job";
    return (
      <span key={i} className="text-xs text-text-muted">
        {formatHoursLabel(a.hours)} → {job}
        {i < entry.allocations.length - 1 ? <span aria-hidden="true"> · </span> : null}
      </span>
    );
  });
  return <p className="space-x-0">{labels}</p>;
}
