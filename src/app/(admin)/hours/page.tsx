import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";

export const dynamic = "force-dynamic";

/**
 * /hours — admin hours overview.
 *
 * Surfaces the queue depth at a glance and links into the approval queue.
 * Per the brief §"Admin surface > /hours (overview)" Phase B keeps this
 * minimal: filters, by-worker / by-job aggregations and CSV export are
 * staged as UNDER CONSTRUCTION because the user's Phase B prompt scopes
 * them to a later phase.
 */
export default async function HoursOverviewPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/hours");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { pending, approved, rejected, fetchError } = await loadOverview(raw);

  return (
    <AdminShell title="Hours">
      <div className="mx-auto max-w-4xl space-y-4">
        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load queue counts</CardTitle>
            <CardDescription className="text-amber-900">{fetchError}</CardDescription>
          </Card>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <QueueCard
            label="Pending approval"
            count={pending.length}
            tone="info"
            href="/hours/approvals"
            description="Worker entries waiting for an admin or leading-hand decision."
          />
          <QueueCard
            label="Approved (this view)"
            count={approved.length}
            tone="success"
            description="Already approved entries returned by the approver queue. Bulk-export lands in Phase F."
          />
          <QueueCard
            label="Rejected (this view)"
            count={rejected.length}
            tone="danger"
            description="Workers see the reason in their own Phil history and can resubmit on legacy My day."
          />
        </div>

        <Card>
          <CardTitle>Up next: review the queue</CardTitle>
          <CardDescription className="mt-1">
            Approve or reject submitted entries with a single click. Leading hands see only entries
            on jobs they run.
          </CardDescription>
          <div className="mt-4">
            <Link
              href="/hours/approvals"
              className="inline-flex items-center rounded-card bg-brand-navy px-5 py-3 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              Open approval queue →
            </Link>
          </div>
        </Card>

        <UnderConstructionPanel
          feature="CSV export · payroll finalisation · Xero push"
          description="Approved-week CSV download, payroll-run snapshots and the Xero push live in Phase F. The legacy /admin/hours surface keeps these flows working today via the existing endpoints."
          legacyHref="/admin/hours"
          legacyLabel="Use legacy /admin/hours for export"
        />

        <UnderConstructionPanel
          feature="Bulk approve · weekly rollup · filters"
          description="Bulk approving a worker's week, the by-worker / by-job aggregation views and date-range filters land later in Phase B once the single-entry loop is verified in production for one week (see ADR-007)."
          legacyHref="/admin/hours"
          legacyLabel="Legacy bulk-approve still works"
        />
      </div>
    </AdminShell>
  );
}

function QueueCard({
  label,
  count,
  tone,
  description,
  href,
}: {
  label: string;
  count: number;
  tone: "info" | "success" | "danger";
  description: string;
  href?: string;
}) {
  const inner = (
    <Card className="h-full">
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-xs uppercase tracking-widest text-text-muted">
          {label}
        </span>
        <Pill tone={tone}>{count}</Pill>
      </div>
      <CardDescription className="mt-3">{description}</CardDescription>
    </Card>
  );
  if (href === "/hours/approvals") {
    return (
      <Link href={href} className="block focus:outline-none">
        {inner}
      </Link>
    );
  }
  return inner;
}

async function loadOverview(cookieValue: string | undefined): Promise<{
  pending: ReadonlyArray<TimeEntry>;
  approved: ReadonlyArray<TimeEntry>;
  rejected: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  try {
    const [pendingRes, approvedRes, rejectedRes] = await Promise.all([
      fetch(`${base}/api/time-entries?scope=approver&status=submitted`, {
        cache: "no-store",
        headers: headersInit,
      }),
      fetch(`${base}/api/time-entries?scope=approver&status=approved`, {
        cache: "no-store",
        headers: headersInit,
      }),
      fetch(`${base}/api/time-entries?scope=approver&status=rejected`, {
        cache: "no-store",
        headers: headersInit,
      }),
    ] as const);
    const pending = await readList(pendingRes);
    const approved = await readList(approvedRes);
    const rejected = await readList(rejectedRes);
    if ("error" in pending || "error" in approved || "error" in rejected) {
      const firstError =
        ("error" in pending && pending.error) ||
        ("error" in approved && approved.error) ||
        ("error" in rejected && rejected.error) ||
        "Unknown error";
      return {
        pending: "error" in pending ? [] : pending.entries,
        approved: "error" in approved ? [] : approved.entries,
        rejected: "error" in rejected ? [] : rejected.entries,
        fetchError: firstError,
      };
    }
    return {
      pending: pending.entries,
      approved: approved.entries,
      rejected: rejected.entries,
      fetchError: null,
    };
  } catch (err) {
    return {
      pending: [],
      approved: [],
      rejected: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function readList(
  res: Response
): Promise<{ entries: ReadonlyArray<TimeEntry> } | { error: string }> {
  if (!res.ok) {
    return { error: `API returned ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { error: "Non-JSON response" };
  }
  const parsed = TimeEntryListResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { error: "Unexpected response shape" };
  }
  return { entries: parsed.data.entries };
}
