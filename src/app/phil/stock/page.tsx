import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { PhilWorkshopStock } from "@/components/phil/PhilWorkshopStock";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";

export const dynamic = "force-dynamic";

/**
 * /phil/stock — Workshop Stock on the phone (workshop_stock, dark).
 *
 * Entered from the More / account screen's reference group (P10: no new tab,
 * no My Day widget). The list loads client-side from /api/workshop-stock, which
 * re-checks the session, the flag and the role on every call — this page only
 * decides whether the surface exists for this viewer (404 while off).
 *
 * docs/workshop-stock.md
 */
export default async function PhilStockPage() {
  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/stock");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("workshop_stock", session))) {
    notFound();
  }
  const sharpenedFlags = await philSharpenedFlags(session);

  return (
    <PhilShell
      title="Workshop stock"
      userId={session.userId ?? ""}
      sharpened={sharpenedFlags.sharpened}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={philInitials(session.name ?? session.username)}
    >
      <div className="space-y-4">
        <PhilBackLink href="/v2/phil">More</PhilBackLink>
        <PhilWorkshopStock />
      </div>
    </PhilShell>
  );
}
