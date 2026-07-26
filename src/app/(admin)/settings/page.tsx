import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { HoursPolicySection } from "@/components/admin/HoursPolicySection";
import { JobTypesSection } from "@/components/admin/JobTypesSection";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isOwnerRole } from "@/lib/auth/roles";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

/**
 * /settings (#222) — the v2 settings hub.
 *
 * One place in the new shell for the company-level config the v2 world needs.
 * Each section either FULLY works here or links out to legacy — no half-ported
 * forms, no fake cards. This base ship hosts two working sections:
 *
 *   - Hours policy (over `GET`/`PUT /api/policy`) — the daily-threshold the
 *     LEGACY approvals bulk-approve / rate-flag rule reads. (#124 closed without
 *     the v2 "Approve all" adopting it; zero `src/` consumers — the copy is
 *     honest about that.)
 *   - Job types (over `api/job-types.js`'s four actions) — list/create/rename/
 *     delete, with the server's "in use by jobs" 409 delete-guard surfaced.
 *
 * Deliberately DROPPED: a "Company basics" card. No `api/` endpoint persists
 * company-profile fields today, so such a card would be fake UI — which the
 * issue's own no-fake-card AC forbids. It lands when a real endpoint does.
 *
 * Personal items (profile, change password, look & feel) are NOT duplicated
 * here. Their legacy `settings.html` page was retired in the legacy-interface
 * cutover (so there's no live page to link out to), and no v2 replacement is
 * built yet — this hub names where they stand rather than faking a control.
 * Notification prefs (#218) and task-generation rules (#224) already have their
 * own /settings/* pages; this hub links to them. Lean-reset re-skin (replica
 * lines 541-563): page-level sub-line instead of an intro card, and an
 * owner-only Owner Console link in "More settings".
 *
 * Admin-tier gated via the normalised-role surface check (same pattern as
 * /settings/notifications) — never a literal 'admin' comparison. Both endpoints
 * are admin-tier server-side too; `canEdit` mirrors that so a non-writer never
 * sees dead controls.
 */
export default async function SettingsHubPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/settings");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const canEdit = canAccessSurface(session.role, "admin");
  // #247: the Xero connection page link renders only when the flag is on for
  // this viewer — the integration stays invisible while dark.
  const xeroEnabled = await isFlagEnabled("xero_connection", session);
  // Owner Console link (replica line 557) — owner-only; everyone else never
  // sees a link they can't open (the /owner gate is fail-closed anyway).
  const owner = isOwnerRole(session.role);

  return (
    <AdminShell title="Settings">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Title lives in the top bar (AdminTopbar h1); this is the lean-reset
            sub-line (replica line 543). */}
        <p className="max-w-[62ch] text-sm text-text-muted">
          Company-level configuration for BuhlOS. Each section below either
          works here or points you to where it lives.
        </p>

        <section aria-label="Hours policy">
          <Card className="space-y-4">
            <div>
              <CardTitle className="text-base">Hours policy</CardTitle>
              <CardDescription className="mt-1">
                The daily-hours threshold for flagging long days on approvals.
              </CardDescription>
            </div>
            <HoursPolicySection canEdit={canEdit} />
          </Card>
        </section>

        <section aria-label="Job types">
          <Card className="space-y-4">
            <div>
              <CardTitle className="text-base">Job types</CardTitle>
              <CardDescription className="mt-1">
                The labels you put on jobs (and that seed the task-generation
                rules). Add, rename or delete them here.
              </CardDescription>
            </div>
            <JobTypesSection canEdit={canEdit} />
          </Card>
        </section>

        <section aria-label="More settings">
          <Card className="space-y-3">
            <CardTitle className="text-base">More settings</CardTitle>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  href={"/settings/notifications" as Route}
                  className="font-semibold text-brand-navy underline underline-offset-2"
                >
                  Notification settings
                </Link>{" "}
                <span className="text-text-muted">
                  — choose which pushes you receive.
                </span>
              </li>
              <li>
                <Link
                  href={"/settings/task-rules" as Route}
                  className="font-semibold text-brand-navy underline underline-offset-2"
                >
                  Task generation rules
                </Link>{" "}
                <span className="text-text-muted">
                  — repeatable task lists by job type / area.
                </span>
              </li>
              {owner ? (
                <li>
                  <Link
                    href={"/owner" as Route}
                    className="font-semibold text-brand-navy underline underline-offset-2"
                  >
                    Owner Console
                  </Link>{" "}
                  <span className="text-text-muted">
                    — platform control &amp; the feature board (owner only).
                  </span>
                </li>
              ) : null}
              {xeroEnabled ? (
                <li>
                  <Link
                    href={"/settings/integrations/xero" as Route}
                    className="font-semibold text-brand-navy underline underline-offset-2"
                  >
                    Xero connection
                  </Link>{" "}
                  <span className="text-text-muted">
                    — connect BuhlOS to Xero (connection only; no payroll data yet).
                  </span>
                </li>
              ) : null}
              <li className="text-text-muted">
                <span className="font-semibold text-text">
                  Profile, change password &amp; look &amp; feel
                </span>{" "}
                — not rebuilt in v2 yet.
              </li>
            </ul>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
