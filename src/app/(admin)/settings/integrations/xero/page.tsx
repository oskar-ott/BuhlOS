import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { XeroConnectionPanel } from "@/components/admin/XeroConnectionPanel";
import { XeroReferenceDataPanel } from "@/components/admin/XeroReferenceDataPanel";
import { XeroWorkerMappingPanel } from "@/components/admin/XeroWorkerMappingPanel";
import { XeroEarningsMappingPanel } from "@/components/admin/XeroEarningsMappingPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

/**
 * /settings/integrations/xero (#247) — the Xero CONNECTION surface.
 *
 * Connection (#247) + the read-only payroll reference cache (#610): OAuth
 * connect, explicit organisation selection, health, disconnect/reconnect, and
 * the employees/calendars/pay-items/tracking snapshot used to validate
 * mappings. Still read-only end to end — the timesheet push is #249 (its own
 * flag), and the CSV export on
 * /hours/period is untouched either way (payroll-boundary ADR: the CSV stays
 * the permanent fallback).
 *
 * Admin-tier gated like every /settings page; the api/xero/* endpoints
 * enforce admin + the xero_connection flag server-side too. When the flag is
 * dark this page states so honestly (it is only reachable by direct URL —
 * the settings-hub link renders only when the flag is on for the viewer).
 */
export default async function XeroIntegrationPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/settings/integrations/xero");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const enabled = await isFlagEnabled("xero_connection", session);

  return (
    <AdminShell title="Xero connection">
      <div className="mx-auto max-w-2xl space-y-6">
        {enabled ? (
          <>
            <XeroConnectionPanel />
            <XeroReferenceDataPanel />
            <XeroWorkerMappingPanel />
            <XeroEarningsMappingPanel />
          </>
        ) : (
          <Card>
            <CardTitle>Xero integration is not enabled</CardTitle>
            <CardDescription className="mt-1">
              The Xero connection isn&rsquo;t switched on for this account or
              environment yet. Payroll keeps working exactly as it does today —
              approved hours export to CSV from the pay-period page. Nothing here
              is hidden behind a broken button: when the integration is enabled,
              this page is where you connect.
            </CardDescription>
          </Card>
        )}
      </div>
    </AdminShell>
  );
}
