import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { StockAdminClient } from "@/components/admin/stock/StockAdminClient";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /stock — Workshop Stock, the office view (workshop_stock, dark).
 *
 * Materials and consumables kept in the workshop — separate from gear (no
 * custody, serials or test-and-tag). Admin tier here; the crew uses
 * /phil/stock. 404 while the flag is off — no trace anywhere else.
 *
 * docs/workshop-stock.md
 */
export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect("/v2/login?next=/stock");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("workshop_stock", session))) {
    notFound();
  }
  const params = await searchParams;
  const itemId = typeof params.item === "string" ? params.item : null;

  return (
    <AdminShell
      title="Workshop stock"
      breadcrumb={
        <Link href="/command-centre" className="underline decoration-accent-yellow decoration-2 underline-offset-2">
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <p className="text-sm text-text-muted">
          Materials and consumables kept in the workshop, where they live, and every movement in and out. Balances are what&rsquo;s been
          recorded — correct them with a count. Taking stock never adds a job cost.
        </p>
        <StockAdminClient initialItemId={itemId} />
      </div>
    </AdminShell>
  );
}
