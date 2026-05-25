import Link from "next/link";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";

/**
 * /v2/phil — Phil landing / profile placeholder.
 *
 * Parallel to legacy public/phil.html which keeps serving /phil via
 * vercel.json. Authenticated visitors get the four live loops linked
 * below (My day, Jobs, Gear, Hours history); the "More" tab still lands
 * here until a profile/settings surface is built.
 */
export default function PhilV2HomePage() {
  return (
    <PhilShell title="Phil">
      <div className="space-y-4">
        <Card className="space-y-3">
          <div>
            <CardTitle>What&rsquo;s live</CardTitle>
            <CardDescription>
              The hours, jobs, gear and snag loops are all on the bottom tabs.
              This page stays as the profile / settings home until that
              surface is built.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/phil/my-day"
              className="inline-flex h-11 items-center justify-center rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              Open My day →
            </Link>
            <Link
              href="/phil/jobs"
              className="inline-flex h-11 items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-subtle"
            >
              Jobs
            </Link>
            <Link
              href="/phil/gear"
              className="inline-flex h-11 items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-medium text-text hover:bg-surface-subtle"
            >
              My gear
            </Link>
          </div>
        </Card>

        <UnderConstructionPanel
          feature="Profile · settings · notifications"
          description="Your worker profile, push-notification preferences and a quick legacy bail-out live here once the loops above are field-stable. For now you can sign out from the legacy Phil if you need to."
          legacyHref="/phil"
          legacyLabel="Open legacy Phil"
        />
      </div>
    </PhilShell>
  );
}
