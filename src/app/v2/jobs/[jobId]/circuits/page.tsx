import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { CircuitScheduleBuilder } from "@/components/circuit-schedule/CircuitScheduleBuilder";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { loadJob, loadSchedule } from "@/domains/circuit-schedule/server-load";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/circuits — Admin circuit schedule.
 *
 * The office side of the schedule builder: the same editable surface a leading
 * hand sees in Phil, here in the admin shell where the finished schedule is
 * reviewed and printed for the handover pack. Auth mirrors the job hub
 * (lh-or-above to view); the API gates the write to canManageJob.
 */
export default async function AdminCircuitSchedulePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/circuits`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  const canManage = canAccessSurface(session.role, "lh");

  const [jobResult, schedule] = await Promise.all([
    loadJob(raw, jobId),
    loadSchedule(raw, jobId),
  ]);

  const backHref = `/v2/jobs/${encodeURIComponent(jobId)}` as Route;

  if (jobResult.kind !== "ok") {
    return (
      <AdminShell title="Circuit schedule" breadcrumb={<BackLink href={backHref} />}>
        <div className="mx-auto max-w-4xl">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job."
                : "We couldn't load that job. Try again in a moment."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title={`${jobResult.job.name} — Circuit schedule`}
      breadcrumb={<BackLink href={backHref} />}
    >
      <div className="mx-auto max-w-4xl">
        <CircuitScheduleBuilder
          jobId={jobId}
          canManage={canManage}
          initialSwitchboards={schedule.switchboards}
          initialCircuits={schedule.circuits}
          loadError={schedule.error}
          printHref={`/v2/jobs/${encodeURIComponent(jobId)}/circuits/print`}
          surface="admin"
        />
      </div>
    </AdminShell>
  );
}

function BackLink({ href }: { href: Route }) {
  return (
    <Link href={href} className="underline decoration-accent-yellow decoration-2 underline-offset-2">
      ← Job
    </Link>
  );
}
