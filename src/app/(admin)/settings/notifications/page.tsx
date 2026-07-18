import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { NotificationPrefsPanel } from "@/components/admin/NotificationPrefsPanel";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

/**
 * /settings/notifications (#218) — the notification preferences panel.
 *
 * This is the FIRST page under /settings. #222 will grow /settings into a
 * proper account/settings hub and absorb this page (a "Notifications" tab or
 * row); until then this is a standalone admin-shell page reached from a small
 * link in the AdminSidebar footer (settings isn't a daily destination, so it's
 * deliberately NOT a nav-group item).
 *
 * The toggles are now REAL: they ride the existing self-only
 * `GET`/`PUT /api/notification-prefs`, and the platform notify() engine (#162,
 * shipped in the same PR) actually consults `notificationPrefs` at delivery —
 * so flipping a switch here changes what pushes you receive, instead of being
 * an inert control over a hard-wired sender.
 *
 * Admin-tier gated via the normalised-role surface check (same pattern as
 * /reports) — never a literal 'admin' comparison. The prefs API itself serves
 * field users too (Phil may get the same toggles later); only this PANEL is
 * admin-shell.
 */
export default async function NotificationSettingsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/settings/notifications");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  // Lean reset: pref rows for hidden features don't render — the panel must
  // never advertise a push type the product can't currently send.
  const snagsEnabled = await isFlagEnabled("snags", session);
  const hiddenKeys = snagsEnabled ? [] : (["snagAssigned", "staleSnags"] as const);

  return (
    <AdminShell title="Notification settings">
      <div className="mx-auto max-w-2xl space-y-6">
        <Card>
          <CardTitle>Notifications</CardTitle>
          <CardDescription className="mt-1">
            Choose which pushes you want. These apply to your account only — turning
            one off silences just that type for you. Useful pings (like hours
            approved) stay on by default; the noisier ones are yours to mute.
            Reminders and digests still need push enabled on your device; manage that
            from the{" "}
            <Link
              href="/command-centre"
              className="font-medium text-brand-navy underline underline-offset-2"
            >
              Command centre
            </Link>
            .
          </CardDescription>
        </Card>

        <section aria-label="Notification preferences">
          <NotificationPrefsPanel hiddenKeys={hiddenKeys} />
        </section>
      </div>
    </AdminShell>
  );
}
