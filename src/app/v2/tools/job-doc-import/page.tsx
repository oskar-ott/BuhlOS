import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { JobDocImportPreview } from "@/components/admin/JobDocImportPreview";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

/**
 * /v2/tools/job-doc-import — the read-only pricing/BOQ workbook import preview
 * (#365 first increment).
 *
 * Server component, admin surface only, gated DARK behind the `job_doc_import`
 * flag: when the flag is off for the viewer the route 404s, so the surface is
 * invisible until proven on a preview deploy. No nav link points here yet (kept
 * out of AdminSidebar deliberately) — reach it by URL while it is dark. The
 * client component posts the workbook to POST /api/job-doc-import, which parses
 * and RETURNS the preview; nothing is ever written.
 */
export default async function JobDocImportPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/v2/tools/job-doc-import");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("job_doc_import", session))) {
    notFound();
  }

  return (
    <AdminShell title="Import pricing workbook">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-slate-900">Import a pricing / BOQ workbook</h1>
          <p className="text-sm text-slate-500">
            Turn a job&rsquo;s pricing spreadsheet into a structured, reviewable bill of quantities
            — packages, priced lines, a commercial reconciliation and the ambiguities a human must
            resolve. This is a preview only; nothing is saved.
          </p>
        </header>
        <JobDocImportPreview />
      </div>
    </AdminShell>
  );
}
