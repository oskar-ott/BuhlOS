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
 * own /settings/* pages; this hub links to them.
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

  return (
    <AdminShell title="Settings">
      <div className="mx-auto max-w-3xl space-y-6">
        <Card>
          <CardTitle>Settings</CardTitle>
          <CardDescription className="mt-1">
            Company-level configuration for the new BuhlOS surfaces. Each section
            below either works here or points you to where it lives. Personal
            settings — profile, password and look &amp; feel — are not duplicated
            here; see &ldquo;More settings&rdquo; below for where they stand.
          </CardDescription>
        </Card>

        <section aria-label="Hours policy">
          <Card className="space-y-4">
            <div>
              <CardTitle>Hours policy</CardTitle>
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
              <CardTitle>Job types</CardTitle>
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
            <div>
              <CardTitle>More settings</CardTitle>
              <CardDescription className="mt-1">
                Other company configuration that already has its own page.
              </CardDescription>
            </div>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  href={"/settings/notifications" as Route}
                  className="font-medium text-brand-navy underline underline-offset-2"
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
                  className="font-medium text-brand-navy underline underline-offset-2"
                >
                  Task generation rules
                </Link>{" "}
                <span className="text-text-muted">
                  — repeatable task lists by job type / area.
                </span>
              </li>
              <li className="text-text-muted">
                <span className="font-medium text-text">
                  Profile, change password &amp; look &amp; feel
                </span>{" "}
                — not rebuilt in v2 yet. The old settings page was retired in the
                interface cutover; a personal-settings slice is tracked for later.
              </li>
            </ul>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
