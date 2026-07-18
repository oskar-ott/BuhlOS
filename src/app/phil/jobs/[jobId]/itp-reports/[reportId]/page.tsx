import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilItpReportBuilder } from "@/components/phil/PhilItpSimple";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string; reportId: string }>;
}

/**
 * /phil/jobs/[jobId]/itp-reports/[reportId] — one ITP report being built on
 * the walk (#912). Same gate stack as the list route; all data moves through
 * the job-scoped API.
 */
export default async function PhilItpReportPage({ params }: PageParams) {
  const { jobId, reportId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(
      `/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/itp-reports/${reportId}`)}`,
    );
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("itp_simple", session))) {
    notFound();
  }

  return (
    <PhilShell title="ITP report">
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}/itp-reports`}>
          All ITPs
        </PhilBackLink>
        <PhilItpReportBuilder jobId={jobId} reportId={reportId} />
      </div>
    </PhilShell>
  );
}
