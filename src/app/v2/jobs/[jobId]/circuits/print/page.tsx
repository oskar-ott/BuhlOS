import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Route } from "next";
import { CircuitSchedulePrintable } from "@/components/circuit-schedule/CircuitSchedulePrintable";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { loadJob, loadSchedule } from "@/domains/circuit-schedule/server-load";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId]/circuits/print — the printable circuit schedule.
 *
 * Deliberately renders WITHOUT the admin shell so a browser print / Save-as-PDF
 * produces a clean schedule (no nav chrome). Auth still gates it (lh-or-above);
 * the data is read-only here — editing happens back on the builder page.
 */
export default async function CircuitSchedulePrintPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/circuits/print`)}`);
  }
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }

  const [jobResult, schedule] = await Promise.all([
    loadJob(raw, jobId),
    loadSchedule(raw, jobId),
  ]);

  const backHref = `/v2/jobs/${encodeURIComponent(jobId)}/circuits` as Route;

  if (jobResult.kind !== "ok") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 text-text">
        <p className="text-sm text-text-muted">
          This job isn&rsquo;t available. <a className="underline" href={backHref}>Back</a>
        </p>
      </div>
    );
  }

  return (
    <CircuitSchedulePrintable
      job={{
        id: jobResult.job.id,
        name: jobResult.job.name,
        ref: jobResult.job.ref ?? undefined,
        siteAddress: jobResult.job.siteAddress ?? undefined,
      }}
      switchboards={schedule.switchboards}
      circuits={schedule.circuits}
      backHref={backHref}
    />
  );
}
