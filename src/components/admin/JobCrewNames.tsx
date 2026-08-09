"use client";

import { useEffect, useState } from "react";
import type { Route } from "next";
import { listEmployees } from "@/domains/employees/client";

/**
 * "Who's on this job" — the assigned crew's real names on the hub's health
 * band (2026-08-09 audit follow-up: the band showed a crew COUNT with no way
 * to see who). Client-fetched off the admin register (listEmployees, the
 * /api/employees read that already carries name + assignedJobIds) so it never
 * blocks the band's instant paint.
 *
 * Honest-or-absent: while loading, on any error, or for a non-admin viewer
 * (the endpoint 403s) this renders NOTHING — the band's count fact stays as
 * the only crew signal, and no name is ever guessed. Disabled employees are
 * excluded; assignment management stays on the register (/employees), which
 * the Manage link opens.
 */

const NAME_CAP = 8;

export function JobCrewNames({ jobId }: { jobId: string }) {
  const [names, setNames] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listEmployees();
      if (cancelled || !res.ok) return;
      // REAL full names (#999: nicknames are greeting-only, never rosters).
      const assigned = res.data.employees
        .map((row) => row.employee)
        .filter((e) => e.status !== "disabled" && e.assignedJobIds.includes(jobId))
        .map((e) => `${e.firstName} ${e.lastName}`.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      setNames(assigned);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!names || names.length === 0) return null;

  const shown = names.slice(0, NAME_CAP);
  const more = names.length - shown.length;

  return (
    <p className="mt-2 text-sm text-text-muted">
      <span className="text-text">{shown.join(", ")}</span>
      {more > 0 ? ` +${more} more` : null}
      {" · "}
      <a
        href={"/employees" as Route}
        className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
      >
        Manage
      </a>
    </p>
  );
}
