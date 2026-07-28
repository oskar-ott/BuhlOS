import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { CrewWeekPanel } from "@/components/admin/CrewWeekPanel";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { EmployeeRegisterClient } from "@/components/admin/EmployeeRegisterClient";
import { CrewSignupPanel } from "@/components/admin/CrewSignupPanel";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { ResourceStatRow } from "@/components/admin/ResourceStatRow";
import { buildPeopleSummary } from "@/domains/resources/summary";
import { loadEmployeesView } from "./load";

/**
 * /employees — BuhlOS employee register + onboarding (Pass O1).
 *
 * Shared server component behind both /employees and /employees/[id] (the
 * latter just deep-links straight to a worker's detail drawer). Gated to the
 * admin surface, same as /gear and /command-centre.
 *
 * Bible: "BuhlOS Phil Onboarding Interface Bible.html" §05 (admin screens).
 */
export async function EmployeesScreen({ selectedId }: { selectedId?: string | null }) {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) redirect("/v2/login?next=/employees");
  if (!canAccessSurface(session.role, "admin")) redirect("/v2/login");

  const view = await loadEmployeesView(raw);

  // Crew sign-up link (dark behind `signup_link`; owner-preview aware).
  const signupLinkEnabled = await isFlagEnabled("signup_link", session);

  // §7 redesign — glanceable crew header. Pure projection over the rows + the
  // server-computed licence worst-status map the register already loads (no
  // extra fetch). Suppressed on a failed load so we never show a fabricated 0.
  const summary = view.fetchError
    ? null
    : buildPeopleSummary({
        rows: view.rows,
        licenceStatusByUserId: view.licenceStatusByUserId,
      });

  return (
    <AdminShell
      title="Employees"
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
        {/* Title lives in the top bar (AdminTopbar h1); this is the lean-reset
            sub-line + KPI header (replica lines 421-428). */}
        <p className="text-sm text-text-muted">
          Add a worker, send an invite, and they set up BuhlOS on their own phone.
        </p>

        {summary ? <ResourceStatRow label="People at a glance" tiles={summary.tiles} /> : null}

        {view.invalidRows > 0 ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>
              {view.invalidRows === 1
                ? "1 record couldn't be displayed"
                : `${view.invalidRows} records couldn't be displayed`}
            </CardTitle>
            <CardDescription className="text-amber-900">
              The rest of the register is shown below. A stored record has an
              unexpected shape — it needs a look, but it no longer hides
              everyone else.
            </CardDescription>
          </Card>
        ) : null}

        {view.fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load employees</CardTitle>
            <CardDescription className="text-amber-900">
              {view.fetchError}. The register reads the same store as the rest of BuhlOS — refresh
              to try again.
            </CardDescription>
          </Card>
        ) : (
          <EmployeeRegisterClient
            initialRows={view.rows}
            emailConfigured={view.emailConfigured}
            activeJobs={view.activeJobs}
            initialSelectedId={selectedId ?? null}
            licenceStatusByUserId={view.licenceStatusByUserId}
          />
        )}

        {/* Crew sign-up link + review queue (dark behind signup_link). */}
        {signupLinkEnabled ? <CrewSignupPanel /> : null}

        {/* #337: weekly crew availability — who's on leave / assigned / free. */}
        <CrewWeekPanel />
      </div>
    </AdminShell>
  );
}
