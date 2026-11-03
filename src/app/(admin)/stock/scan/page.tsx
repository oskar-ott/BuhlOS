import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { StockScanStation } from "@/components/admin/stock/StockScanStation";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /stock/scan — the scanner display (workshop_stock, dark): a USB barcode scanner
 * at the office computer, each scan logged and given its location. Office,
 * on a computer. docs/workshop-stock.md
 */
export default async function StockScanPage() {
  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect("/v2/login?next=/stock/scan");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("workshop_stock", session))) {
    notFound();
  }

  return (
    <AdminShell
      title="Barcode scanner"
      breadcrumb={
        <Link href="/stock" className="underline decoration-accent-yellow decoration-2 underline-offset-2">
          ← Workshop stock
        </Link>
      }
    >
      <StockScanStation />
    </AdminShell>
  );
}
