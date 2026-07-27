import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { philInitials, philSharpenedFlags } from "@/lib/phil/sharpened";

export const dynamic = "force-dynamic";

/**
 * /phil/gear — Phil My Gear, marked COMING SOON.
 *
 * The Phase C gear list (held assets + return / report-damaged /
 * report-missing — PhilGearList / PhilGearSharpened) is built but not part
 * of the launch surface, so the page says so honestly instead of rendering
 * a register the office isn't running yet (P7 — no fake UI, no invented
 * numbers). The tab keeps its slot so workers know where gear will live;
 * the list components stay in the tree for when it switches back on.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Tab Gear
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 */
export default async function PhilGearPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/gear");
  }
  if (!canAccessSurface(session.role, "phil")) {
    redirect("/v2/login");
  }
  // #760: gear kill-switch — when the owner turns gear off, the surface 404s.
  if (!(await isFlagEnabled("gear", session))) {
    notFound();
  }

  // Sharpened-chrome flag (cached flags.json read) — server-resolved boolean.
  const sharpenedFlags = await philSharpenedFlags(session);

  return (
    <PhilShell
      title={sharpenedFlags.sharpened ? "Gear" : "My gear"}
      userId={session.userId ?? ""}
      sharpened={sharpenedFlags.sharpened}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={philInitials(session.name ?? session.username)}
    >
      <div className="space-y-4">
        {sharpenedFlags.sharpened ? null : (
          <PhilBackLink href="/phil/my-day">My day</PhilBackLink>
        )}

        <EmptyState
          title="Gear — coming soon"
          description="Tools and equipment checked out to you will live here — return them or report damage from your phone. Until then, sort gear with the office like you do now."
        />
      </div>
    </PhilShell>
  );
}
