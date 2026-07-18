import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilItpReportsList } from "@/components/phil/PhilItpSimple";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /phil/jobs/[jobId]/itp-reports — the simple mobile ITP builder's list
 * (#912). Server component: gates session + surface + the `itp_simple` flag
 * (dark = 404, the #760 no-trace route layer), then hands off to the client.
 * Job assignment is enforced by the API — an unassigned worker sees the
 * shell but every fetch 403s with the standard message.
 */
export default async function PhilItpReportsPage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/phil/jobs/${jobId}/itp-reports`)}`);
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("itp_simple", session))) {
    notFound();
  }

  return (
    <PhilShell title="ITPs">
      <div className="space-y-4">
        <PhilBackLink href={`/phil/jobs/${encodeURIComponent(jobId)}`}>Back to job</PhilBackLink>
        <PhilItpReportsList jobId={jobId} />
      </div>
    </PhilShell>
  );
}
