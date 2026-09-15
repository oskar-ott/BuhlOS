import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { InvoiceReviewClient } from "@/components/admin/invoices/InvoiceReviewClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /invoices/[invoiceId] — review one supplier document: the original PDF
 * beside what was read from it, the exact IV match reason, and the
 * confirmation / exclusion actions. Admin-tier; 404 while invoice_capture is off.
 */
export default async function InvoiceReviewPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/invoices/${invoiceId}`)}`);
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("invoice_capture", session))) {
    notFound();
  }
  if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) {
    notFound();
  }

  return (
    <AdminShell
      title="Supplier invoice"
      breadcrumb={
        <Link
          href="/invoices"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Supplier invoices
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl">
        <InvoiceReviewClient invoiceId={invoiceId} />
      </div>
    </AdminShell>
  );
}
