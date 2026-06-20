import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/roles";
import { CircuitScheduleApp } from "@/components/admin/circuit-schedule/CircuitScheduleApp";
import { SAMPLE_BOARDS, SAMPLE_JOB } from "@/domains/circuit-schedule/sample-boards";
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
 * SAMPLE DATA: renders the "100 Arthur" sample boards in memory (honestly labelled).
 * Persistence, wiring to this job's real circuits, and the Phil field view are
 * follow-up slices.
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

  return (
    <AdminShell
      title="Circuit schedules"
      breadcrumb={
        <Link href={`/v2/jobs/${jobId}`} className="text-sm text-text-muted hover:text-text">
          ← Back to job
        </Link>
      }
    >
      <p className="mb-3 text-xs text-text-muted">
        Sample data ({SAMPLE_JOB.name}) — not yet wired to this job&rsquo;s circuits.
      </p>
      <CircuitScheduleApp job={SAMPLE_JOB} initialBoards={SAMPLE_BOARDS} storageKey={`cs-view:${jobId}`} />
    </AdminShell>
  );
}
