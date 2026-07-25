import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { AdminShell } from "@/components/admin/AdminShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /gear — admin gear register, marked COMING SOON.
 *
 * The Phase C register (assign / return / retire, §7 glanceable header,
 * test-and-tag + calibration compliance board — GearRegisterClient et al.)
 * is built but not part of the launch surface, so the page says so honestly
 * instead of rendering a register the office isn't running yet. The nav
 * entry keeps its slot so the office knows where gear will live; the
 * register components stay in the tree for when it switches back on.
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
  // #760: gear kill-switch — when the owner turns gear off, the surface 404s.
  if (!(await isFlagEnabled("gear", session))) {
    notFound();
  }

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
        {/* Title lives in the top bar (AdminTopbar h1). */}
        <p className="text-sm text-text-muted">
          Who has what · test-and-tag and calibration currency · assign, return, retire.
        </p>

        <EmptyState
          title="Coming soon"
          description="The gear register — who holds what, test-and-tag and calibration currency, assign / return / retire — opens here when gear tracking goes live."
        />
      </div>
    </AdminShell>
  );
}
