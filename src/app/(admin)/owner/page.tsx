import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { OwnerConsole } from "@/components/admin/OwnerConsole";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { isOwnerRole } from "@/lib/auth/roles";
import { OwnerSummarySchema } from "@/domains/platform/owner-console";

export const dynamic = "force-dynamic";

/**
 * /owner — the Owner Console (docs/owner-console.md): the product/platform-owner
 * control surface (app health, usage, feature flags, problems, audit, coverage,
 * next actions). Owner-only, read-only first slice.
 *
 * ACCESS (defence in depth):
 *   1. Middleware coarse-gates /owner to the admin tier (the decoded cookie
 *      carries no email, so it can't do the owner-only narrowing).
 *   2. This page resolves access AUTHORITATIVELY by calling the owner-gated
 *      /api/owner endpoint with the session cookie. That endpoint HMAC-verifies
 *      the session, reads the fresh user, and gates to OWNER only (role 'owner'
 *      OR the OWNER_EMAILS allowlist). A 403 here means "authenticated but not
 *      owner" → notFound() (the console's existence is not revealed).
 *   3. The same endpoint IS the data source, so the gate and the data can never
 *      disagree, and no sensitive data is rendered for a non-owner.
 *
 * Like /reports, the data comes from an api/*.js function which does not run
 * under `next dev`; PR previews are the verification surface. When the endpoint
 * is unreachable (local dev), only a stored-'owner'-role user sees a degraded
 * shell — everyone else 404s — so local DX never weakens the production gate.
 */
export default async function OwnerConsolePage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/owner");
  }

  const result = await loadOwnerSummary(raw);

  if (result.status === 401) {
    redirect("/v2/login?next=/owner");
  }
  if (result.status === 403) {
    // Authenticated, but not the owner — hide the console entirely.
    notFound();
  }

  if (result.status === 200) {
    const parsed = OwnerSummarySchema.safeParse(result.body);
    if (parsed.success) {
      return (
        <AdminShell title="Owner Console">
          <OwnerConsole summary={parsed.data} />
        </AdminShell>
      );
    }
    return (
      <AdminShell title="Owner Console">
        <Notice
          title="Owner data unavailable"
          body="The owner endpoint responded with an unexpected shape. No data is shown rather than guessing — check /api/owner."
        />
      </AdminShell>
    );
  }

  // Non-200 / non-403 (unreachable, 404, 5xx). Only a stored-owner-role user
  // sees the degraded shell; everyone else is hidden behind a 404.
  if (!isOwnerRole(session.role)) {
    notFound();
  }
  return (
    <AdminShell title="Owner Console">
      <Notice
        title="Owner data endpoint unavailable in this environment"
        body="The /api/owner function is not reachable here (api/* functions don't run under next dev). Verify the live console on a preview deploy."
      />
    </AdminShell>
  );
}

interface LoadResult {
  status: number | "unreachable";
  body: unknown;
}

async function loadOwnerSummary(cookieValue: string | undefined): Promise<LoadResult> {
  if (!cookieValue) return { status: 401, body: null };
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/owner`, {
      cache: "no-store",
      headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: "unreachable", body: null };
  }
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-5xl">
      <Card>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="mt-1">{body}</CardDescription>
      </Card>
    </div>
  );
}
