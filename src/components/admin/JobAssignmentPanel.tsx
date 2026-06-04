"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { setAssignedJobIds, errorText } from "@/domains/users/client";
import {
  diffWorkerAssignments,
  isAssignedToJob,
} from "@/domains/users/assignment";
import type { AssignableWorker } from "@/domains/users/types";

interface Props {
  jobId: string;
  jobName?: string;
  /** Assignable field/LH workers, already filtered + sorted server-side. */
  initialWorkers: ReadonlyArray<AssignableWorker>;
  /** Non-null when the server couldn't load the worker list (non-blocking). */
  loadError?: string | null;
}

type SaveMessage = { kind: "success" | "error"; text: string };

/**
 * "Assigned field workers" — the modern BuhlOS v2 replacement for legacy
 * /admin/crew assignment. Lives on /v2/jobs/[jobId]/builder (admin-only route).
 *
 * Writes to the production login store (users.json) via PUT /api/users, which
 * is the SOURCE OF TRUTH for Phil job visibility — once a field worker is
 * assigned to an ACTIVE job here, it appears in their /phil/jobs. Each save
 * preserves the worker's other assigned jobs (assignment.ts computes the full
 * toggled array) and PUTs only the workers whose membership changed.
 *
 * Security: the panel is reachable only from the admin-only builder route, and
 * GET/PUT /api/users are admin-tier-gated server-side; it carries only the four
 * secret-free worker fields (id/username/role/assignedJobIds) — never hashes.
 */
export function JobAssignmentPanel({
  jobId,
  jobName,
  initialWorkers,
  loadError = null,
}: Props) {
  // Baseline truth: each worker's assignment as last loaded/saved.
  const [workers, setWorkers] = useState<ReadonlyArray<AssignableWorker>>(initialWorkers);
  // Current checkbox selection for THIS job.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialWorkers.filter((w) => isAssignedToJob(w, jobId)).map((w) => w.id))
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<SaveMessage | null>(null);

  const pendingChanges = useMemo(
    () => diffWorkerAssignments(workers, jobId, selected),
    [workers, jobId, selected]
  );
  const dirty = pendingChanges.length > 0;
  const assignedCount = selected.size;

  function toggle(workerId: string) {
    setMessage(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  }

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(null);

    const failures: string[] = [];
    const savedById = new Map<string, string[]>();
    for (const change of pendingChanges) {
      const res = await setAssignedJobIds(change.id, change.assignedJobIds);
      if (res.ok) savedById.set(change.id, change.assignedJobIds);
      else failures.push(`${change.username}: ${errorText(res.error)}`);
    }

    // Commit successful changes into the baseline so the panel reflects saved
    // state and a re-save only sends what's still pending.
    if (savedById.size > 0) {
      setWorkers((prev) =>
        prev.map((w) =>
          savedById.has(w.id) ? { ...w, assignedJobIds: savedById.get(w.id)! } : w
        )
      );
    }

    if (failures.length === 0) {
      setMessage({
        kind: "success",
        text: `Saved — ${savedById.size} ${savedById.size === 1 ? "worker" : "workers"} updated.`,
      });
    } else {
      setMessage({
        kind: "error",
        text: `Couldn't update ${failures.length} of ${pendingChanges.length}: ${failures.join("; ")}`,
      });
    }
    setSaving(false);
  }

  return (
    <Card
      id="assigned-field-workers"
      className="mt-6 scroll-mt-6 space-y-4"
      aria-labelledby="assign-workers-heading"
    >
      <div className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          <span id="assign-workers-heading">Assigned field workers</span>
          <Pill tone="neutral">{`${assignedCount} assigned`}</Pill>
        </CardTitle>
        <CardDescription>
          Choose which field workers see{" "}
          {jobName ? <strong>{jobName}</strong> : "this job"} in Phil. A worker
          sees the job in their app once it&rsquo;s active and they&rsquo;re
          assigned here. Their other job assignments are left untouched.
        </CardDescription>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Couldn&rsquo;t load the worker list ({loadError}). Refresh to try again.
          <div className="mt-2">
            <RefreshButton />
          </div>
        </div>
      ) : null}

      {workers.length === 0 ? (
        <EmptyState
          title="No field workers to assign"
          description="Add tradies, apprentices or leading hands in the team/employees area first — only field-tier accounts can be assigned to a job."
        />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {workers.map((w) => {
            const checked = selected.has(w.id);
            return (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  id={`assign-${w.id}`}
                  checked={checked}
                  onChange={() => toggle(w.id)}
                  disabled={saving}
                  className="h-4 w-4 shrink-0 rounded border-border accent-brand-navy"
                  aria-label={`Assign ${w.username} to this job`}
                />
                <label
                  htmlFor={`assign-${w.id}`}
                  className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3"
                >
                  <span className="truncate font-medium text-text">{w.username}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Pill tone="neutral">{w.role}</Pill>
                    <span className="text-xs text-text-muted">
                      {checked ? "Assigned" : "Not assigned"}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={
            message.kind === "error"
              ? "text-sm text-state-danger"
              : "text-sm text-state-success"
          }
        >
          {message.text}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save assignments"}
        </Button>
        {dirty && !saving ? (
          <span className="text-xs text-text-muted">
            {pendingChanges.length} unsaved{" "}
            {pendingChanges.length === 1 ? "change" : "changes"}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
