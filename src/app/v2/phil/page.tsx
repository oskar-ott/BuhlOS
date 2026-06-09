import Link from "next/link";
import type { Route } from "next";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSignOutButton } from "@/components/phil/PhilSignOutButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";

/**
 * /v2/phil — Phil landing / "More" tab profile placeholder.
 *
 * Per the Interface Bible vNext §16.4 (Pass 1 — "Demote the four nav
 * cards on Phil home"), this surface no longer duplicates the bottom-tab
 * links to /phil/my-day, /phil/jobs and /phil/gear. The tab bar owns
 * those. What remains is: a short orientation line, an onboarding replay
 * card, an account card (sign out), and the profile/settings UC panel.
 */
export default function PhilV2HomePage() {
  return (
    <PhilShell title="Phil">
      <div className="space-y-4">
        <Card className="space-y-2">
          <CardTitle>You&rsquo;re on Phil</CardTitle>
          <CardDescription>
            Use the bottom tabs for your day, jobs and gear. This page is
            where your profile and notification settings will live.
          </CardDescription>
        </Card>

        <Card className="space-y-3">
          <div>
            <CardTitle>New here?</CardTitle>
            <CardDescription>
              Three-minute tour of what Phil does. Replay any time — Hours,
              Gear, Jobs, on-site evidence, permissions, then back here.
            </CardDescription>
          </div>
          <div>
            <Link
              href={"/phil/onboarding" as Route}
              className="inline-flex h-11 items-center justify-center rounded-card bg-accent-yellow px-4 text-sm font-semibold text-brand-navy hover:brightness-95"
            >
              Start the tour →
            </Link>
          </div>
        </Card>

        <Card className="space-y-3">
          <div>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Signing out returns you to the login screen. You&rsquo;ll need
              your username and PIN to get back in.
            </CardDescription>
          </div>
          <PhilSignOutButton />
        </Card>

        <UnderConstructionPanel
          feature="Profile · settings · notifications"
          description="Your worker profile and push-notification preferences live here once the loops above are field-stable. The legacy Phil app is still one tap away if you need it."
          legacyHref="/phil"
          legacyLabel="Open legacy Phil"
        />
      </div>
    </PhilShell>
  );
}
