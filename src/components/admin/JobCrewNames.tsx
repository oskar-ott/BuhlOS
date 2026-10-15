"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { listEmployees } from "@/domains/employees/client";
import { cn } from "@/lib/cn";

/**
 * "Who's on this job" — the assigned crew's real names on the hub's health
 * band (2026-08-09 audit follow-up: the band showed a crew COUNT with no way
 * to see who), and — since the 2026-10-15 shorter-paths audit — the place the
 * office PUTS people on the job. Before this, "Manage" opened the employee
 * register, whose drawer is read-only for assignments: the command centre
 * said "assign workers so hours can be logged" and the office had no screen
 * that could. The assign/unassign writes go through the existing
 * POST /api/crew (admin / leading hand on the job), which is what the field
 * list reads (users.json assignedJobIds) — no second assignment model.
 *
 * Client-fetched off the admin register (listEmployees, the /api/employees
 * read that already carries name + assignedJobIds) so it never blocks the
 * band's instant paint.
 *
 * Honest-or-absent: while loading, on any error, or for a non-admin viewer
 * (the endpoint 403s) this renders NOTHING — the band's count fact stays as
 * the only crew signal, and no name is ever guessed. Disabled employees are
 * excluded everywhere; login-less employee records (no users.json account)
 * can't be put on a job here because the field app keys on the account.
 */

const NAME_CAP = 8;

interface CrewPerson {
  /** users.json account id — what /api/crew and the field app key on. */
  userId: string;
  name: string;
  assigned: boolean;
}

export function JobCrewNames({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [people, setPeople] = useState<CrewPerson[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listEmployees();
      if (cancelled || !res.ok) return;
      // REAL full names (#999: nicknames are greeting-only, never rosters).
      const next = res.data.employees
        .map((row) => row.employee)
        .filter((e) => e.status !== "disabled" && !!e.userId)
        .map((e) => ({
          userId: e.userId!,
          name: `${e.firstName} ${e.lastName}`.trim(),
          assigned: e.assignedJobIds.includes(jobId),
        }))
        .filter((p) => p.name.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      setPeople(next);
    })();
    return () => {
      cancelled = true;
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    };
  }, [jobId]);

  // The band's crew COUNT is server-rendered from job stats; after a change,
  // re-render the page once (debounced across quick successive toggles) so the
  // number and the names agree. The names themselves update optimistically.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => router.refresh(), 700);
  }, [router]);

  const toggle = useCallback(
    async (person: CrewPerson) => {
      if (busyId) return;
      const action = person.assigned ? "unassign" : "assign";
      setBusyId(person.userId);
      setProblem(null);
      setPeople((prev) =>
        prev
          ? prev.map((p) => (p.userId === person.userId ? { ...p, assigned: !p.assigned } : p))
          : prev
      );
      try {
        const res = await fetch(`/api/crew?action=${action}&jobId=${encodeURIComponent(jobId)}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: person.userId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(
            body?.error || `Couldn't ${action === "assign" ? "add" : "remove"} ${person.name}`
          );
        }
        scheduleRefresh();
      } catch (err) {
        // Revert the optimistic flip and say what refused, in plain words.
        setPeople((prev) =>
          prev
            ? prev.map((p) =>
                p.userId === person.userId ? { ...p, assigned: person.assigned } : p
              )
            : prev
        );
        setProblem(err instanceof Error ? err.message : "Something refused the change");
      } finally {
        setBusyId(null);
      }
    },
    [busyId, jobId, scheduleRefresh]
  );

  if (!people) return null;

  const assigned = people.filter((p) => p.assigned);
  const shown = assigned.slice(0, NAME_CAP);
  const more = assigned.length - shown.length;

  return (
    <div className="mt-2 text-sm text-text-muted">
      <p>
        {assigned.length > 0 ? (
          <>
            <span className="text-text">{shown.map((p) => p.name).join(", ")}</span>
            {more > 0 ? ` +${more} more` : null}
            {" · "}
          </>
        ) : (
          <>Nobody on this job yet · </>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`job-crew-picker-${jobId}`}
          className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {open ? "Done" : assigned.length > 0 ? "Manage" : "Add workers"}
        </button>
      </p>
      {open ? (
        <ul
          id={`job-crew-picker-${jobId}`}
          className="mt-2 grid gap-1 sm:grid-cols-2"
          aria-label="Workers on this job"
        >
          {people.map((p) => (
            <li key={p.userId}>
              <button
                type="button"
                onClick={() => void toggle(p)}
                disabled={busyId !== null}
                aria-pressed={p.assigned}
                className={cn(
                  "flex min-h-[44px] w-full items-center justify-between gap-3 rounded-[6px] border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60",
                  p.assigned
                    ? "border-brand-navy bg-surface-subtle text-text"
                    : "border-border text-text hover:bg-surface-subtle"
                )}
              >
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-xs font-semibold text-text-muted">
                  {busyId === p.userId ? "Saving…" : p.assigned ? "On the job · Remove" : "Add"}
                </span>
              </button>
            </li>
          ))}
          {people.length === 0 ? (
            <li className="text-xs text-text-muted">
              No workers with an app login yet — add them under People.
            </li>
          ) : null}
        </ul>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-2 text-xs font-medium text-state-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
