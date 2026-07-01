import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";
import { isAdminRole } from "@/lib/auth/roles";
import { CircuitScheduleApp } from "@/components/admin/circuit-schedule/CircuitScheduleApp";
import { loadCircuitSchedule } from "@/domains/circuit-schedule/server-load";
import "./circuit-schedule.css";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/circuit-schedule — the Circuit Schedule Builder (office).
 *
 * Implementation of the BuhlOS Circuit Schedule design (claude.ai/design handoff):
 * board overview → schedule builder → print preview, over the pure AS/NZS-3000
 * compute engine in src/domains/circuit-schedule. Admin-gated, mirroring the other
 * job sub-routes (job-control / documents / itps).
 *
 * Data: the rich `boards` facet of /api/job-circuits (job.circuitBoards) — the
 * shared store the Phil field view also reads/writes. Loaded server-side here,
 * edited live in CircuitScheduleApp which debounce-saves back.
 */
export default async function CircuitSchedulePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/circuit-schedule`)}`);
  }
  if (!isAdminRole(session.role)) {
    redirect("/v2/login");
  }
  // #760: circuit-schedule kill-switch — when the owner turns it off, 404.
  if (!(await isFlagEnabled("circuit_schedule", session))) {
    notFound();
  }

  const { job, boards, error } = await loadCircuitSchedule(raw, jobId);
  // This route is admin-gated, so the viewer can manage the schedule. The
  // server PUT re-checks canManageJob and the client degrades to read-only on
  // a 403, so this is a hint, not the authority.
  const canManage = isAdminRole(session.role);

  return (
    <AdminShell
      title="Circuit schedules"
      breadcrumb={
        <Link href={`/v2/jobs/${jobId}`} className="text-sm text-text-muted hover:text-text">
          ← Back to job
        </Link>
      }
    >
      <CircuitScheduleApp
        job={job}
        jobId={jobId}
        initialBoards={boards}
        canManage={canManage}
        loadError={error}
        storageKey={`cs-view:${jobId}`}
      />
    </AdminShell>
  );
}
