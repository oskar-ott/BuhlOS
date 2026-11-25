import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { NoJobInvoices } from "@/components/admin/customer-invoices/NoJobInvoices";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /getting-paid — invoices to clients that are NOT tied to a job (#1166,
 * customer_invoices, dark).
 *
 * For money that isn't billed job by job — one invoice a month against a
 * builder's payment schedule, say. The office writes the invoice here (who it
 * is for, what it is for, its lines) and sends it to Xero as a draft. A job's
 * own invoices stay on the job's "Getting paid" card.
 *
 * Admin-tier only; 404 while the flag is off — no trace on any other surface.
 *
 * docs/customer-invoices.md → "An invoice with no job"
 */
export default async function GettingPaidPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/getting-paid");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("customer_invoices", session))) {
    notFound();
  }

  return (
    <AdminShell
      title="Getting paid"
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        <p className="text-sm text-text-muted">
          Invoices that aren&rsquo;t tied to a job. A job&rsquo;s own invoices are on the job, under
          Getting paid.
        </p>
        <NoJobInvoices />
      </div>
    </AdminShell>
  );
}
