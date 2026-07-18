import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { QaStatusBoard } from "@/components/admin/QaStatusBoard";
import { blobQaStatusDeps, runQaStatus } from "@/server/itp/qa-status";

export const dynamic = "force-dynamic";

/**
 * /qa — cross-job QA status dashboard (#290, first increment).
 *
 * Admin surface: ITP/QA exposure across active jobs (instance counts by status,
 * open points, oldest unactioned age, awaiting sign-off), drill-through to the
 * existing per-job ITP surface. Mirrors the other top-level admin pages
 * (itp-templates / defects): gate auth → read server-side → AdminShell + board.
 *
 * The reader scans `jobs/<jobId>/itps.json` per active job directly server-side
 * (this page is admin-gated), mirroring how the Phil/job-control reads call their
 * server readers. Read-only — nothing is written or compiled.
 */
export default async function QaStatusPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/qa");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: ITP kill-switch — the nav item is flag-gated; this closes the deep
  // link too, so the surface 404s while the itp flag is off.
  if (!(await isFlagEnabled("itp", session))) notFound();

  const result = await runQaStatus(blobQaStatusDeps(), new Date().toISOString());

  return (
    <AdminShell title="QA status">
      <QaStatusBoard result={result} />
    </AdminShell>
  );
}
