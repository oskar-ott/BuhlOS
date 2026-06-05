import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { PhilPageIntro } from "@/components/phil/ui/PhilPageIntro";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PhilBackLink } from "@/components/phil/ui/PhilBackLink";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { GearListResponseSchema } from "@/domains/gear/schema";
import type { GearAsset } from "@/domains/gear/types";
import { PhilGearList } from "@/components/phil/PhilGearList";

export const dynamic = "force-dynamic";

/**
 * /phil/gear — Phil My Gear (Phase C).
 *
 * Server component loads the worker's own held assets (api/assets.js
 * server-side filters to currentHolderId === me for non-admin roles) and
 * hands them to the client list that drives return / report-damaged /
 * report-missing actions.
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

  const { assets, fetchError } = await loadMyGear(raw);

  return (
    <PhilShell title="My gear">
      <div className="space-y-4">
        <PhilBackLink href="/phil/my-day">My day</PhilBackLink>

        <PhilPageIntro
          title="My gear"
          description="Tools and equipment checked out to you. Return or report condition here."
          meta={
            assets.length > 0 ? (
              <span className="whitespace-nowrap text-xs uppercase tracking-wider text-text-muted">
                {assets.length} {assets.length === 1 ? "item" : "items"}
              </span>
            ) : undefined
          }
        />

        {fetchError ? (
          <PhilNotice tone="warning" title="Couldn’t load gear" role="alert">
            {fetchError}. Try again shortly, or open the legacy My gear page below.
          </PhilNotice>
        ) : null}

        {assets.length === 0 && !fetchError ? (
          <EmptyState
            title="Nothing in your name"
            description="When admin or a leading hand transfers something to you, it'll show up here."
          />
        ) : (
          <PhilGearList initialAssets={assets} />
        )}

        <UnderConstructionPanel
          feature="QR scan check-out"
          description="Tap-to-scan from the van or depot is on the roadmap. For now, admin or a leading hand transfers gear to you through the office register, and you can return or report condition here."
          legacyHref="/my-gear"
          legacyLabel="Open legacy My gear"
        />
      </div>
    </PhilShell>
  );
}

async function loadMyGear(cookieValue: string | undefined): Promise<{
  assets: ReadonlyArray<GearAsset>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/assets`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { assets: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = GearListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { assets: [], fetchError: "Unexpected response shape" };
    }
    // The server already filters to "what I hold" for non-admin roles, but
    // defence-in-depth: an admin opening /phil/gear directly would see all
    // assets, which is wrong for the worker surface. Filter client-side to
    // assets that are actively held (so admin testing the page sees a
    // sensible non-empty list of assigned items, but never the depot pool).
    return { assets: parsed.data.assets.filter((a) => a.currentHolderId), fetchError: null };
  } catch (err) {
    return {
      assets: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
