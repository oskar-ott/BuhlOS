import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { MaterialRequestsInbox } from "@/components/admin/MaterialRequestsInbox";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import {
  MATERIAL_REQUEST_STATUSES,
  MaterialRequestListResponseSchema,
} from "@/domains/material-requests/schema";
import type { MaterialRequestItem, MaterialRequestStatus } from "@/domains/material-requests/types";

export const dynamic = "force-dynamic";

/**
 * /material-requests — the BuhlOS Material Requests inbox (PR 11).
 *
 * The cross-job procurement triage surface for material needs. Server
 * component fetches /api/material-requests (cross-job, admin-tier gated);
 * the client component owns filtering + the procurement actions (approve /
 * order / mark-delivered / cancel).
 *
 * Cross-ref:
 *   docs/architecture/material-requests.md
 *   docs/architecture/observations.md §5 (Snag conversion was the precedent)
 *   api/material-requests.js
 */
export default async function MaterialRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; focus?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/material-requests");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  if (!(await isFlagEnabled("material_requests", session))) notFound();

  // Deep-link query (Needs Attention → a specific request). Both are validated
  // and tolerant: an unknown status is ignored, an unknown focus id just opens
  // nothing. The page never errors on a missing/garbage query.
  const sp = await searchParams;
  const initialStatus: MaterialRequestStatus | "" =
    sp.status && (MATERIAL_REQUEST_STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as MaterialRequestStatus)
      : "";
  const initialSelectedId = typeof sp.focus === "string" && sp.focus ? sp.focus : null;

  const { requests, fetchError } = await loadRequests(raw);

  return (
    <AdminShell title="Material requests">
      <div className="mx-auto max-w-5xl space-y-5">
        <Card>
          <CardTitle>Material requests</CardTitle>
          <CardDescription>
            Tracked field-to-office procurement requests. Field workers raise
            them as observations in the field app; the office converts those to real
            requests here and works them through requested → approved →
            ordered → delivered. The legacy{" "}
            <code className="text-xs">/admin/materials</code> takeoff / PO /
            invoice surface is separate and unchanged.
          </CardDescription>
        </Card>

        <MaterialRequestsInbox
          initialRequests={requests}
          fetchError={fetchError}
          initialStatus={initialStatus}
          initialSelectedId={initialSelectedId}
        />
      </div>
    </AdminShell>
  );
}

async function loadRequests(cookieValue: string | undefined): Promise<{
  requests: ReadonlyArray<MaterialRequestItem>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/material-requests`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) {
      return { requests: [], fetchError: `API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = MaterialRequestListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { requests: [], fetchError: "Unexpected response shape" };
    }
    return { requests: parsed.data.requests, fetchError: null };
  } catch (err) {
    return {
      requests: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
