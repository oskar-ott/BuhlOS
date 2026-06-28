"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import { cancelLeave, myLeave, requestLeave } from "@/domains/timesheets/client";
import type { LeaveRequest } from "@/domains/timesheets/types";

/**
 * /phil/leave (#333) — request leave, see outcomes, cancel while pending.
 * Approved leave feeds the server's missing-day computation, so a worker
 * on holiday stops being chased for "missing hours".
 */

const LEAVE_TYPES = [
  { value: "annual", label: "Annual leave" },
  { value: "sick", label: "Sick leave" },
  { value: "rdo", label: "RDO" },
  { value: "unpaid", label: "Unpaid leave" },
  { value: "other", label: "Other" },
] as const;

const STATUS_TONE: Record<LeaveRequest["status"], "success" | "warning" | "danger" | "neutral"> = {
  approved: "success",
  pending: "warning",
  declined: "danger",
  cancelled: "neutral",
};

interface Props {
  initialRequests: ReadonlyArray<LeaveRequest>;
  fetchError: string | null;
  /** Today (YYYY-MM-DD, business tz) — floors the date pickers so a worker
   *  can't request leave that's already in the past. */
  todayISO?: string;
}

export function PhilLeaveClient({ initialRequests, fetchError, todayISO }: Props) {
  const router = useRouter();
  const [requests, setRequests] = useState<ReadonlyArray<LeaveRequest>>(initialRequests);
  const [type, setType] = useState<string>("annual");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [note, setNote] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(fetchError);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const inputClass = "h-12 w-full rounded-card border border-border bg-surface px-3 text-base";

  async function refresh() {
    const result = await myLeave();
    if (result.ok) setRequests(result.data.requests);
  }

  function submit() {
    setErrorMessage(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result = await requestLeave({
        type,
        fromDate,
        toDate: toDate || fromDate,
        note: note.trim() || undefined,
      });
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSuccessMessage("Request sent — the office will confirm it.");
      setFromDate("");
      setToDate("");
      setNote("");
      await refresh();
      router.refresh();
    });
  }

  function cancel(request: LeaveRequest) {
    setErrorMessage(null);
    startTransition(async () => {
      const result = await cancelLeave(request.id);
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSuccessMessage("Request cancelled.");
      await refresh();
      router.refresh();
    });
  }

  const sorted = [...requests].sort((a, b) => (b.fromDate ?? "").localeCompare(a.fromDate ?? ""));

  return (
    <div className="space-y-4">
      {errorMessage ? (
        <PhilNotice tone="danger" role="alert">
          {errorMessage}
        </PhilNotice>
      ) : null}
      {successMessage ? (
        <PhilNotice tone="success" role="status">
          {successMessage}
        </PhilNotice>
      ) : null}

      <Card className="space-y-3">
        <h2 className="font-display text-base text-text">Request leave</h2>
        <label className="block text-sm">
          <span className="text-text-muted">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass} data-testid="leave-type">
            {LEAVE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-text-muted">First day</span>
            <input type="date" value={fromDate} min={todayISO} onChange={(e) => setFromDate(e.target.value)} className={inputClass} data-testid="leave-from" />
          </label>
          <label className="block text-sm">
            <span className="text-text-muted">Last day (optional)</span>
            <input type="date" value={toDate} min={fromDate || todayISO} onChange={(e) => setToDate(e.target.value)} className={inputClass} data-testid="leave-to" />
          </label>
        </div>
        <p className="text-xs text-text-muted">Leave the last day blank for a single day off.</p>
        <label className="block text-sm">
          <span className="text-text-muted">Note (optional)</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </label>
        <Button
          size="lg"
          className="w-full"
          onClick={submit}
          disabled={isPending || !fromDate}
          data-testid="leave-submit"
        >
          {isPending ? "Sending…" : "Send request"}
        </Button>
        <p className="text-xs text-text-muted">
          Once the office approves, those days stop showing as &ldquo;missing hours&rdquo; — no
          more holiday nag pings.
        </p>
      </Card>

      {sorted.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">No leave requests yet.</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {sorted.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">
                    {LEAVE_TYPES.find((t) => t.value === r.type)?.label ?? r.type}
                  </p>
                  <p className="text-xs text-text-muted">
                    {r.fromDate}
                    {r.toDate !== r.fromDate ? ` → ${r.toDate}` : ""}
                    {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>
                  {r.status === "pending" ? (
                    <Button size="sm" variant="secondary" disabled={isPending} onClick={() => cancel(r)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
