import Link from "next/link";
import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";

/**
 * /v2/phil — Phase A Phil landing (parallel to legacy public/phil.html which
 * keeps serving /phil via vercel.json).
 *
 * Phase B kept this page so the original Phase A spec still passes
 * (unauthenticated /v2/phil still redirects to /v2/login), but for
 * authenticated visitors it now points at the real /phil/my-day surface.
 */
export default function PhilV2HomePage() {
  return (
    <PhilShell title="Phil">
      <div className="space-y-4">
        <Card className="space-y-3">
          <div>
            <CardTitle>Today</CardTitle>
            <CardDescription>
              The Phil hours loop is live. Open My day to log a Standard day (7h 36m) or custom
              hours.
            </CardDescription>
          </div>
          <Link
            href="/phil/my-day"
            className="inline-flex h-12 items-center justify-center rounded-card bg-brand-navy px-5 text-sm font-medium text-text-inverse hover:bg-accent-ink"
          >
            Open My day →
          </Link>
        </Card>

        <UnderConstructionPanel
          feature="Gear, Snags, Jobs in Phil"
          description="Gear check-out/in is Phase C; raising a snag and the in-job task view are Phase D. Hours logging is the only field loop that's live."
          legacyHref="/phil"
          legacyLabel="Open legacy Phil for Gear / Snags / Jobs"
        />
      </div>
    </PhilShell>
  );
}
