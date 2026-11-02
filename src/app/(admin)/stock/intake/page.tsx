import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { StockIntake } from "@/components/admin/stock/StockIntake";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /stock/intake — the camera table (workshop_stock, dark): a webcam above a table,
 * each object placed under it identified, logged and given its location. Office,
 * on a computer. docs/workshop-stock.md
 */
export default async function StockIntakePage() {
  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect("/v2/login?next=/stock/intake");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("workshop_stock", session))) {
    notFound();
  }

  return (
    <AdminShell
      title="Camera table"
      breadcrumb={
        <Link href="/stock" className="underline decoration-accent-yellow decoration-2 underline-offset-2">
          ← Workshop stock
        </Link>
      }
    >
      <StockIntake />
    </AdminShell>
  );
}
