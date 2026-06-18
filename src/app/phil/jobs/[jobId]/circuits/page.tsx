import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
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
 * /phil/jobs/[jobId]/circuits — Phil field circuit schedule.
 *
 * The field side of the schedule builder: filled in front of the board on a
 * phone. Same component as the admin page; the API gates the write to
 * canManageJob, so a leading hand edits and a tradie gets a read-only view.
 */
export default async function PhilCircuitSchedulePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/circuits`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  // Write is server-gated to canManageJob; LH-and-above get the editing UI,
  // a tradie gets read-only. The API is the real gate — this just keeps us
  // from offering a save that would 403.
  const canManage = canAccessSurface(session.role, "lh");

  const [jobResult, schedule] = await Promise.all([
    loadJob(raw, jobId),
    loadSchedule(raw, jobId),
  ]);

  if (jobResult.kind !== "ok") {
    return (
      <PhilShell title="Circuit schedule">
        <div className="space-y-4">
          <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Job</PhilBackLink>
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {jobResult.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask your PM to add you."
                : "We couldn't load that job. Pull to refresh in a moment."}
            </CardDescription>
          </Card>
        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell title="Circuit schedule">
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>
          {jobResult.job.name}
        </PhilBackLink>
        <CircuitScheduleBuilder
          jobId={jobId}
          canManage={canManage}
          initialSwitchboards={schedule.switchboards}
          initialCircuits={schedule.circuits}
          loadError={schedule.error}
          printHref={`/v2/jobs/${encodeURIComponent(jobId)}/circuits/print`}
          surface="phil"
        />
      </div>
    </PhilShell>
  );
}
