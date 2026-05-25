import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { GearListResponseSchema } from "@/domains/gear/schema";
import type { GearAsset, GearHolderUser } from "@/domains/gear/types";
import { GearRegisterClient } from "@/components/admin/GearRegisterClient";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /gear — Phase C admin gear register.
 *
 * Server component loads the full asset list (including archived) and the
 * worker list for the assignment picker, then hands both to a client
 * component that handles assign / return / mark-condition mutations.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Section Gear
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Gear
 *   api/assets.js
 */
export default async function GearRegisterPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/gear");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { assets, holders, fetchError } = await loadRegister(raw);

  return (
    <AdminShell
      title="Gear · register"
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <Card>
          <CardTitle>Assets · who has what</CardTitle>
          <CardDescription>
            Assign gear to a worker, return to depot, or mark damaged / missing. Every action is
            logged with actor and timestamp in the asset history.
          </CardDescription>
        </Card>

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load assets</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. Refresh the page to try again.
            </CardDescription>
          </Card>
        ) : null}

        {assets.length === 0 && !fetchError ? (
          <EmptyState
            title="No assets yet"
            description="Use the legacy /admin/assets page to seed the register; the new register reads the same store."
          />
        ) : (
          <GearRegisterClient initialAssets={assets} holders={holders} />
        )}

        <UnderConstructionPanel
          feature="Bulk operations · QR scanning · label printing"
          description="Bulk assign / bulk retire, camera-based QR scanning, and label printer (Nimbot/Brother) integration are deferred — the v1 register is single-item flows only. Use the legacy admin assets page for create / edit / archive in the meantime."
          legacyHref="/admin/assets"
          legacyLabel="Open legacy /admin/assets"
        />
      </div>
    </AdminShell>
  );
}

const HoldersResponseSchema = z.object({
  users: z.array(
    z
      .object({
        id: z.string(),
        username: z.string(),
        role: z.string(),
      })
      .passthrough()
  ),
});

async function loadRegister(cookieValue: string | undefined): Promise<{
  assets: ReadonlyArray<GearAsset>;
  holders: ReadonlyArray<GearHolderUser>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const cookieHeader = cookieValue
    ? ({ cookie: `${SESSION_COOKIE}=${cookieValue}` } as const)
    : undefined;

  try {
    const [assetsRes, holdersRes] = await Promise.all([
      fetch(`${base}/api/assets?archived=1`, { cache: "no-store", headers: cookieHeader }),
      fetch(`${base}/api/users?action=listTradies`, { cache: "no-store", headers: cookieHeader }),
    ]);

    if (!assetsRes.ok) {
      return { assets: [], holders: [], fetchError: `Assets API returned ${assetsRes.status}` };
    }
    const assetsBody = await assetsRes.json();
    const assetsParsed = GearListResponseSchema.safeParse(assetsBody);
    if (!assetsParsed.success) {
      return { assets: [], holders: [], fetchError: "Unexpected assets response shape" };
    }

    let holders: ReadonlyArray<GearHolderUser> = [];
    if (holdersRes.ok) {
      const holdersBody = await holdersRes.json();
      const holdersParsed = HoldersResponseSchema.safeParse(holdersBody);
      if (holdersParsed.success) {
        holders = holdersParsed.data.users.filter(
          (u) => u.role !== "admin" && u.role !== "client"
        );
      }
    }
    return { assets: assetsParsed.data.assets, holders, fetchError: null };
  } catch (err) {
    return {
      assets: [],
      holders: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
