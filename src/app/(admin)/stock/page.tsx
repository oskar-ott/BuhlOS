import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Camera, Grid3x3 } from "lucide-react";
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
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <p className="min-w-0 flex-1 basis-96 text-sm text-text-muted">
            What the crew have recorded in the workshop. Recorded — not a guarantee of what&rsquo;s on the shelf; correct it with a count.
            Taking stock never adds a job cost.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/stock/intake" className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-border bg-surface px-3 text-[13px] font-medium text-text hover:border-border-strong" data-testid="stock-open-intake">
              <Camera aria-hidden="true" className="h-4 w-4" /> Camera table
            </Link>
            <Link href="/stock/locations" className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-border bg-surface px-3 text-[13px] font-medium text-text hover:border-border-strong" data-testid="stock-open-matrix">
              <Grid3x3 aria-hidden="true" className="h-4 w-4" /> Location matrix
            </Link>
          </div>
        </div>
        <StockAdminClient initialItemId={itemId} />
      </div>
    </AdminShell>
  );
}
