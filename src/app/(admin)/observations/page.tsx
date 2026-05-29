import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { ObservationsInbox } from "@/components/admin/ObservationsInbox";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import type { ObservationItem } from "@/domains/observations/types";

export const dynamic = "force-dynamic";

/**
 * /observations — the BuhlOS Observations Inbox (PR 3).
 *
 * The office triage surface for field-to-office site truth captured in Phil
 * (blockers, plan mismatches, material needs, questions, variations, defects,
 * site instructions) and BuhlOS. Server component does the cookie-bearing
 * fetch against /api/observations (cross-job inbox, admin-tier gated); the
 * client component owns filtering + the triage/resolve/convert mutations.
 *
 * Cross-ref:
 *   docs/architecture/observations.md
 *   docs/route-ownership.md §9 (nav contract) — /observations is APPROVED
 *   api/observations.js
 */
export default async function ObservationsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/observations");
  }
  // Office/admin surface — matches the cross-job API gate in api/observations.js.
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { observations, fetchError } = await loadObservations(raw);

  return (
    <AdminShell title="Observations">
      <div className="mx-auto max-w-5xl space-y-5">
        <Card>
          <CardTitle>Observations</CardTitle>
          <CardDescription>
            Field notes, blockers, plan mismatches, material needs, questions (RFIs),
            variations, defects and site instructions from Phil — turned into decisions.
            Triage, assign, resolve, or flag for conversion.
          </CardDescription>
        </Card>

        <ObservationsInbox
          initialObservations={observations}
          fetchError={fetchError}
          viewer={{
            id: session.userId ?? session.sub ?? "",
            name: session.name ?? "You",
            role: String(session.role ?? ""),
          }}
        />
      </div>
    </AdminShell>
  );
}

async function loadObservations(cookieValue: string | undefined): Promise<{
  observations: ReadonlyArray<ObservationItem>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/observations`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { observations: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = ObservationListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { observations: [], fetchError: "Unexpected response shape" };
    }
    return { observations: parsed.data.observations, fetchError: null };
  } catch (err) {
    return {
      observations: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
