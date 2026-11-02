import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { StockLocationMatrix } from "@/components/admin/stock/StockLocationMatrix";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /stock/locations — the location matrix (workshop_stock, dark): the racks, their
 * shelves and bins, and the words for what goes in each. docs/workshop-stock.md
 */
export default async function StockLocationsPage() {
  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect("/v2/login?next=/stock/locations");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("workshop_stock", session))) {
    notFound();
  }

  return (
    <AdminShell
      title="Location matrix"
      breadcrumb={
        <Link href="/stock" className="underline decoration-accent-yellow decoration-2 underline-offset-2">
          ← Workshop stock
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <p className="text-sm text-text-muted">
          See what&rsquo;s in each bin, and click a bin to write what belongs there. New stock with no location goes by those words. Changing them never moves stock already recorded; only Put it here and Move do.
        </p>
        <StockLocationMatrix />
      </div>
    </AdminShell>
  );
}
