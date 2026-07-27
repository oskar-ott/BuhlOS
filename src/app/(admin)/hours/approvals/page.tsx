import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { HoursApprovalsQueue } from "@/components/admin/HoursApprovalsQueue";
import { HoursTabs } from "@/components/admin/HoursTabs";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";

export const dynamic = "force-dynamic";

/**
 * /hours/approvals — Phase B approval queue.
 *
 * Server component does the cookie-bearing fetch against the legacy
 * /api/time-entries?scope=approver endpoint; the client component handles
 * approve / reject mutations and the optimistic UI.
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md
 *            §"Admin surface > /hours/approvals"
 */
export default async function HoursApprovalsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/hours/approvals");
  }
  // Approver queue is admin-only here; leading-hand support is verified at
  // the API layer (server returns 403 if a worker tries to load this URL).
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: Hours kill-switch — hide the office surface when the owner turns it off.
  if (!(await isFlagEnabled("hours", session))) notFound();

  const { entries, fetchError } = await loadPendingQueue(raw);

  return (
    <AdminShell
      title="Hours · approvals"
      breadcrumb={
        <Link
          href="/hours"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Hours overview
        </Link>
      }
    >
      {/* Section tabs (#415) — navigation chrome only, above all content. */}
      <HoursTabs />
      <div className="mx-auto max-w-4xl space-y-4">
        <Card>
          <CardTitle>Submitted entries</CardTitle>
          <CardDescription>
            Grouped by worker. Approve to push to payroll prep, or reject with a reason — the worker
            gets a push notification with the reason in it.
          </CardDescription>
        </Card>

        <HoursApprovalsQueue initialEntries={entries} fetchError={fetchError} canUndo={isAdminRole(session.role)} />
      </div>
    </AdminShell>
  );
}

async function loadPendingQueue(cookieValue: string | undefined): Promise<{
  entries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/time-entries?scope=approver&status=submitted`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { entries: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TimeEntryListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { entries: [], fetchError: "Unexpected response shape" };
    }
    return { entries: parsed.data.entries, fetchError: null };
  } catch (err) {
    return {
      entries: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
