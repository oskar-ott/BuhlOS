import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { NewJobForm } from "@/components/admin/NewJobForm";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canCreateJob } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /v2/jobs/new — create a job (draft) in the Job Builder.
 *
 * Literal-admin only: POST /api/jobs gates on `me.role !== 'admin'` server-side
 * — narrower than the admin tier that can edit a job (canManageJob). We gate on
 * canCreateJob (literal admin) here so a boss/pm never sees a form whose submit
 * would 403.
 *
 * The form itself (client) creates the draft and routes into
 * /v2/jobs/[jobId]/builder. Middleware also gates the /v2/jobs prefix;
 * this is defence-in-depth.
 *
 * Cross-ref:
 *   src/components/admin/NewJobForm.tsx — the create form
 *   src/app/v2/jobs/page.tsx — the jobs list that links here
 */
export default async function NewJobPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/v2/jobs/new");
  }
  if (!canCreateJob(session.role)) {
    redirect("/v2/jobs");
  }

  return (
    <AdminShell
      title="New job"
      breadcrumb={
        <Link
          href="/v2/jobs"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Jobs
        </Link>
      }
    >
      <div className="mx-auto max-w-2xl space-y-4">
        <NewJobForm />
      </div>
    </AdminShell>
  );
}
