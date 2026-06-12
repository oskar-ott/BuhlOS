"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { allLeave, decideLeave, requestLeave } from "@/domains/timesheets/client";
import type { LeaveRequest } from "@/domains/timesheets/types";

/**
 * Leave approvals on /hours (#333). Approve/decline pending requests
 * (the worker gets a push either way) and record retroactive sick leave
 * on a worker's behalf — auto-approved, because "called in sick
 * yesterday" is the reality the office actually handles.
 */

interface Props {
  initialRequests: ReadonlyArray<LeaveRequest>;
  fetchError: string | null;
  workers: ReadonlyArray<{ id: string; username: string }>;
}

export function LeaveApprovalsCard({ initialRequests, fetchError, workers }: Props) {
  const router = useRouter();
  const [requests, setRequests] = useState<ReadonlyArray<LeaveRequest>>(initialRequests);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [type, setType] = useState("sick");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [isPending, startTransition] = useTransition();

  const pending = requests.filter((r) => r.status === "pending");
  const inputClass = "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm";

  async function refresh() {
    const result = await allLeave();
    if (result.ok) setRequests(result.data.requests);
    router.refresh();
  }

  const [declining, setDeclining] = useState<LeaveRequest | null>(null);
  const [declineNote, setDeclineNote] = useState("");

  function decide(request: LeaveRequest, approve: boolean, note?: string) {
    setNotice(null);
    startTransition(async () => {
      const result = await decideLeave(request.id, approve, note);
      if (!result.ok) {
        setNotice({ tone: "bad", text: result.error.message });
        return;
      }
      setNotice({ tone: "ok", text: `${approve ? "Approved" : "Declined"} ${request.userName}'s leave.` });
      await refresh();
    });
  }

  function record() {
    setNotice(null);
    startTransition(async () => {
      const result = await requestLeave({
        type,
        fromDate,
        toDate: toDate || fromDate,
        userId,
      });
      if (!result.ok) {
        setNotice({ tone: "bad", text: result.error.message });
        return;
      }
      setNotice({ tone: "ok", text: "Recorded and approved." });
      setRecordOpen(false);
      setUserId("");
      setFromDate("");
      setToDate("");
      await refresh();
    });
  }

  return (
    <Card role="region" aria-label="Leave">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Leave</CardTitle>
          <CardDescription className="mt-1">
            Approved days stop counting as missing hours everywhere — board, Phil and the
            reminder pings.
          </CardDescription>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setRecordOpen((v) => !v)} data-testid="leave-record-open">
          Record on behalf
        </Button>
      </div>

      {fetchError ? <p className="mt-2 text-sm text-text-muted">{fetchError}</p> : null}
      {notice ? (
        <p
          role="status"
          className={`mt-2 rounded-card border px-3 py-2 text-sm ${
            notice.tone === "ok" ? "border-state-success text-state-success" : "border-state-danger text-state-danger"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {recordOpen ? (
        <div className="mt-3 grid gap-2 rounded-card border border-border p-3 sm:grid-cols-5">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputClass} aria-label="Worker" data-testid="leave-record-worker">
            <option value="">— Worker —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.username}
              </option>
            ))}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass} aria-label="Type">
            <option value="sick">Sick</option>
            <option value="annual">Annual</option>
            <option value="rdo">RDO</option>
            <option value="unpaid">Unpaid</option>
            <option value="other">Other</option>
          </select>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClass} aria-label="First day" />
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputClass} aria-label="Last day" />
          <Button size="sm" onClick={record} disabled={isPending || !userId || !fromDate} data-testid="leave-record-save">
            Record (auto-approves)
          </Button>
        </div>
      ) : null}

      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No pending requests.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {pending.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-text">{r.userName ?? r.userId}</span>
                <span className="text-text-muted">
                  {" "}
                  · {r.type} · {r.fromDate}
                  {r.toDate !== r.fromDate ? ` → ${r.toDate}` : ""}
                  {r.note ? ` · “${r.note}”` : ""}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => decide(r, true)} disabled={isPending} data-testid="leave-approve">
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => { setDeclining(r); setDeclineNote(""); }} disabled={isPending}>
                  Decline
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {declining ? (
        <div className="mt-3 space-y-2 rounded-card border border-state-danger p-3">
          <p className="text-sm text-text">
            Decline {declining.userName}&rsquo;s {declining.type} leave? They see your reason.
          </p>
          <input
            type="text"
            value={declineNote}
            onChange={(e) => setDeclineNote(e.target.value)}
            placeholder="Reason (optional)"
            className={inputClass}
            data-testid="leave-decline-note"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDeclining(null)} disabled={isPending}>
              Back
            </Button>
            <Button
              size="sm"
              disabled={isPending}
              data-testid="leave-decline-confirm"
              onClick={() => {
                const target = declining;
                setDeclining(null);
                if (target) decide(target, false, declineNote.trim() || undefined);
              }}
            >
              Decline leave
            </Button>
          </div>
        </div>
      ) : null}

      {requests.some((r) => r.status === "approved") ? (
        <p className="mt-2 text-xs text-text-muted">
          {requests.filter((r) => r.status === "approved").length} approved on file
          {" · "}
          <Pill tone="neutral">feeds missing-day detection</Pill>
        </p>
      ) : null}
    </Card>
  );
}
