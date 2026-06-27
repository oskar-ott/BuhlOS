import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { HoursApprovalsQueue } from "@/components/admin/HoursApprovalsQueue";
import { HoursTabs } from "@/components/admin/HoursTabs";
import { MobileApprovalsHub } from "@/components/admin/MobileApprovalsHub";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import { ExpenseListResponseSchema } from "@/domains/expenses/schema";
import { MaterialRequestListResponseSchema } from "@/domains/material-requests/schema";
import { isOpenRequest } from "@/domains/material-requests/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { summariseItpReviewQueue } from "../../command-centre/itp-queue-card";

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

  const [{ entries, fetchError }, approvalsCounts] = await Promise.all([
    loadPendingQueue(raw),
    loadOtherApprovalCounts(raw),
  ]);

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
      {/* Mobile-only consolidated triage of the OTHER day-to-day approvals
          (expenses / ITPs / materials / dayworks / proof). Hours stay below as
          the page's main, already-responsive content. */}
      <div className="mx-auto mb-4 max-w-4xl">
        <MobileApprovalsHub counts={approvalsCounts} />
      </div>
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

        <UnderConstructionPanel
          feature="Leading-hand crew view"
          description="A dedicated leading-hand view of just their crew's entries isn't wired yet — it's on the backlog. Bulk approve ('Approve all') is on this page; re-opening an approved entry is on the Weekly closeout tab."
        />
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

/**
 * Counts for the mobile approvals triage — the OTHER day-to-day approval types
 * (hours are this page's own queue). Each fetch is best-effort and degrades to
 * 0 so a slow/failed source never blocks the hours queue. Real counts only (P7).
 */
async function loadOtherApprovalCounts(
  cookieValue: string | undefined
): Promise<{ expenses: number; itps: number; materials: number }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = {
    cache: "no-store" as const,
    headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
  };

  async function count<T>(
    url: string,
    parse: (body: unknown) => T | null,
    tally: (data: T) => number
  ): Promise<number> {
    try {
      const res = await fetch(`${base}${url}`, init);
      if (!res.ok) return 0;
      const data = parse(await res.json());
      return data ? tally(data) : 0;
    } catch {
      return 0;
    }
  }

  const [expenses, materials, itps] = await Promise.all([
    count(
      "/api/expenses?status=submitted",
      (b) => {
        const p = ExpenseListResponseSchema.safeParse(b);
        return p.success ? p.data : null;
      },
      (d) => d.expenses.length
    ),
    count(
      "/api/material-requests",
      (b) => {
        const p = MaterialRequestListResponseSchema.safeParse(b);
        return p.success ? p.data : null;
      },
      (d) => d.requests.filter((r) => isOpenRequest(r.status)).length
    ),
    count(
      // Only needs the ITP-needs-review count (statsItpsNeedsReview) — served by
      // the fast statsOnly read, skipping the ~8s jobs.json monolith.
      "/api/jobs?withStats=1&statsOnly=1",
      (b) => {
        const p = JobListResponseSchema.safeParse(b);
        return p.success ? p.data : null;
      },
      (d) => summariseItpReviewQueue(d.jobs.filter((j) => j.status !== "archived")).count
    ),
  ]);

  return { expenses, itps, materials };
}
