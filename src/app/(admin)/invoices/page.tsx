import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { InvoiceInboxClient } from "@/components/admin/invoices/InvoiceInboxClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /invoices — the supplier-invoice inbox (invoice_capture, dark).
 *
 * Supplier invoices forwarded by the office (or uploaded here) are read,
 * matched EXACTLY to a job by the wholesaler's printed IV job reference, and
 * confirmed by the office before their ex-GST amount becomes a job cost.
 * Admin-tier only; 404 while the flag is off — no trace on any other surface.
 *
 * docs/invoice-capture.md
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/invoices");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("invoice_capture", session))) {
    notFound();
  }
  const params = await searchParams;
  const jobId = typeof params.jobId === "string" ? params.jobId : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;

  return (
    <AdminShell
      title="Supplier invoices"
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <p className="text-sm text-text-muted">
          Invoices the wholesalers email the office, matched to a job by the IV job reference they
          print. Nothing becomes a job cost until you confirm it.
        </p>
        <InvoiceInboxClient initialJobId={jobId} initialStatus={status} />
      </div>
    </AdminShell>
  );
}
