import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardTitle, CardDescription } from "@/components/ui/Card";
import { CrossJobActivityFeed } from "@/components/admin/CrossJobActivityFeed";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { AuditLogListResponseSchema } from "@/domains/audit-log/schema";
import type { AuditLogEntry } from "@/domains/audit-log/types";

/**
 * Company-wide activity feed (#220) — `/activity`. One read-only, day-grouped
 * view of what happened across every job, over the same monthly audit blobs via
 * `GET /api/audit-log?scope=all` (admin-tier only, bounded). End-of-day review
 * in two minutes instead of a job-by-job tour.
 *
 * Cross-ref:
 *   api/audit-log.js — scope=all branch (the bounded cross-job read)
 *   src/components/admin/CrossJobActivityFeed.tsx — the client surface
 *   src/components/admin/ActivityRow.tsx — the row shared with the per-job feed
 */
export default async function ActivityPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session) redirect("/v2/login");
  // Office tier and up; the endpoint additionally enforces admin-tier.
  if (!canAccessSurface(session.role, "admin")) redirect("/phil/my-day");

  const { entries, jobNameById, error } = await loadActivity(raw);

  return (
    <AdminShell title="Activity">
      <div className="mx-auto max-w-4xl">
        {error === "forbidden" ? (
          <Card>
            <CardTitle>Admin only</CardTitle>
            <CardDescription className="mt-1">
              The cross-job activity feed is an admin-tier view. Per-job history stays available on each job.
            </CardDescription>
          </Card>
        ) : (
          <CrossJobActivityFeed entries={entries} jobNameById={jobNameById} fetchError={error === "error" ? "Activity read failed" : null} />
        )}
      </div>
    </AdminShell>
  );
}

async function loadActivity(cookieValue: string | undefined): Promise<{
  entries: ReadonlyArray<AuditLogEntry>;
  jobNameById: Record<string, string>;
  error: "forbidden" | "error" | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const init = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  const [actRes, jobsRes] = await Promise.allSettled([
    fetch(`${base}/api/audit-log?scope=all&months=2`, { cache: "no-store", headers: init }),
    fetch(`${base}/api/jobs`, { cache: "no-store", headers: init }),
  ]);

  let entries: ReadonlyArray<AuditLogEntry> = [];
  let error: "forbidden" | "error" | null = null;
  if (actRes.status === "fulfilled") {
    const r = actRes.value;
    if (r.status === 403) error = "forbidden";
    else if (!r.ok) error = "error";
    else {
      const body = await r.json().catch(() => null);
      const parsed = AuditLogListResponseSchema.safeParse(body);
      if (parsed.success) entries = parsed.data.entries;
      else error = "error";
    }
  } else {
    error = "error";
  }

  const jobNameById: Record<string, string> = {};
  if (jobsRes.status === "fulfilled" && jobsRes.value.ok) {
    const body = await jobsRes.value.json().catch(() => null);
    const jobs = body && Array.isArray(body.jobs) ? body.jobs : [];
    for (const j of jobs) if (j && j.id) jobNameById[j.id] = j.name || j.id;
  }

  return { entries, jobNameById, error };
}
