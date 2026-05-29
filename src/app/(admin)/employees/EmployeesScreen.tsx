import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { EmployeeRegisterClient } from "@/components/admin/EmployeeRegisterClient";
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
        <Card>
          <CardTitle>People · one worker, one invite, one app</CardTitle>
          <CardDescription>
            Add a worker, send them an invite, and they set up Phil on their own phone. The status
            on each row updates as they open the invite and finish setup.
          </CardDescription>
        </Card>

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
          />
        )}

        <UnderConstructionPanel
          feature="Bulk re-invite · licences · vehicles · inductions · payroll"
          description="Adding workers, email invites (with resend / expired-replacement), and the Phil setup flow (confirm details, PIN, intro) are live. Still to come: bulk re-invite, licence / vehicle / induction registers, and payroll."
        />
      </div>
    </AdminShell>
  );
}
