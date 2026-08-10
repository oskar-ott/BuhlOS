import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Route } from "next";
import {
  Bell,
  ChevronRight,
  Clock3,
  Link2,
  ListChecks,
  ShieldCheck,
  Tags,
  UserRound,
  type LucideIcon,
} from "lucide-react";
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
 * own /settings/* pages; this hub links to them.
 *
 * Visual language matches the command-centre redesign: kicker headings over
 * grouped cards, icon chips on card headers, and "More settings" as a single
 * tappable-row card (icon / title+sub / chevron) instead of underlined links.
 *
 * Admin-tier gated via the normalised-role surface check (same pattern as
 * /settings/notifications) — never a literal 'admin' comparison. Both endpoints
 * are admin-tier server-side too; `canEdit` mirrors that so a non-writer never
 * sees dead controls.
 */

function IconChip({ icon: Icon, muted }: { icon: LucideIcon; muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        muted
          ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-border bg-surface-subtle text-text-muted"
          : "flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-border bg-surface-subtle text-brand-navy"
      }
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

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

  const moreLinks: Array<{
    key: string;
    href: Route;
    title: string;
    sub: string;
    icon: LucideIcon;
  }> = [
    {
      key: "notifications",
      href: "/settings/notifications" as Route,
      title: "Notification settings",
      sub: "Choose which pushes you receive.",
      icon: Bell,
    },
    {
      key: "task-rules",
      href: "/settings/task-rules" as Route,
      title: "Task generation rules",
      sub: "Repeatable task lists by job type / area.",
      icon: ListChecks,
    },
    ...(owner
      ? [
          {
            key: "owner",
            href: "/owner" as Route,
            title: "Owner Console",
            sub: "Platform control & the feature board (owner only).",
            icon: ShieldCheck,
          },
        ]
      : []),
    ...(xeroEnabled
      ? [
          {
            key: "xero",
            href: "/settings/integrations/xero" as Route,
            title: "Xero connection",
            sub: "Connect BuhlOS to Xero (connection only; no payroll data yet).",
            icon: Link2,
          },
        ]
      : []),
  ];

  return (
    <AdminShell title="Settings">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Title lives in the top bar (AdminTopbar h1); this is the lean-reset
            sub-line (replica line 543). */}
        <p className="max-w-[62ch] text-sm text-text-muted">
          Company-level configuration for BuhlOS. Each section below either
          works here or points you to where it lives.
        </p>

        <div className="space-y-3.5">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-muted">
            Company configuration
          </h2>

          <section aria-label="Hours policy">
            <Card className="space-y-4">
              <div className="flex items-start gap-3">
                <IconChip icon={Clock3} />
                <div className="min-w-0">
                  <CardTitle className="text-base">Hours policy</CardTitle>
                  <CardDescription className="mt-0.5">
                    The daily-hours threshold for flagging long days on
                    approvals.
                  </CardDescription>
                </div>
              </div>
              <HoursPolicySection canEdit={canEdit} />
            </Card>
          </section>

          <section aria-label="Job types">
            <Card className="space-y-4">
              <div className="flex items-start gap-3">
                <IconChip icon={Tags} />
                <div className="min-w-0">
                  <CardTitle className="text-base">Job types</CardTitle>
                  <CardDescription className="mt-0.5">
                    The labels you put on jobs (and that seed the
                    task-generation rules). Add, rename or delete them here.
                  </CardDescription>
                </div>
              </div>
              <JobTypesSection canEdit={canEdit} />
            </Card>
          </section>
        </div>

        <section aria-label="More settings" className="space-y-3.5">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-muted">
            More settings
          </h2>
          <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
            {moreLinks.map((row, i) => {
              const Icon = row.icon;
              return (
                <Link
                  key={row.key}
                  href={row.href}
                  className={
                    "grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-navy" +
                    (i > 0 ? " border-t border-t-border" : "")
                  }
                >
                  <IconChip icon={Icon} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-display text-[15px] font-semibold text-text">
                      {row.title}
                    </span>
                    <span className="text-[13px] leading-snug text-text-muted">
                      {row.sub}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 text-text-muted"
                  />
                </Link>
              );
            })}
            {/* Honest footnote, not a link: no v2 personal-settings page exists
                yet, so this row names where things stand instead of faking a
                destination. */}
            <div className="grid grid-cols-[auto_1fr] items-center gap-4 border-t border-t-border px-5 py-4">
              <IconChip icon={UserRound} muted />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-display text-[15px] font-semibold text-text">
                  Profile, change password &amp; look &amp; feel
                </span>
                <span className="text-[13px] leading-snug text-text-muted">
                  These are not rebuilt in v2 yet.
                </span>
              </span>
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
