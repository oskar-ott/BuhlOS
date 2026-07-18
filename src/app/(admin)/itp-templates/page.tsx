import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { ItpTemplateLibrary } from "@/components/admin/ItpTemplateLibrary";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { ITPTemplateListResponseSchema } from "@/domains/itp/schema";
import type { ITPTemplateSummary } from "@/domains/itp/types";

export const dynamic = "force-dynamic";

/**
 * /itp-templates — the company ITP check library (#284).
 *
 * Authoring previously lived only in the legacy SPA, which the cutover
 * deleted — until this page, templates couldn't be created or edited at
 * all. Admin-tier only (writes are admin-gated server-side; the archived
 * list is an admin-only read).
 */
export default async function ItpTemplatesPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/itp-templates");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: ITP kill-switch — the nav item is flag-gated; this closes the deep
  // link too, so the surface 404s while the itp flag is off.
  if (!(await isFlagEnabled("itp", session))) notFound();

  const { templates, fetchError } = await loadTemplates(raw);

  return (
    <AdminShell
      title="ITP templates"
      breadcrumb={
        <Link
          href="/command-centre"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Command centre
        </Link>
      }
    >
      <div className="mx-auto max-w-4xl">
        <ItpTemplateLibrary initialTemplates={templates} fetchError={fetchError} />
      </div>
    </AdminShell>
  );
}

async function loadTemplates(
  cookieValue: string | undefined,
): Promise<{ templates: ITPTemplateSummary[]; fetchError: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/itp-templates?includeArchived=1`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { templates: [], fetchError: `Templates API returned ${res.status}` };
    const parsed = ITPTemplateListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { templates: [], fetchError: "Unexpected response shape" };
    return { templates: [...parsed.data.templates], fetchError: null };
  } catch (err) {
    return {
      templates: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
