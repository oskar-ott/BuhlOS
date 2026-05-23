import { PhilShell } from "@/components/phil/PhilShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";

/**
 * /v2/phil — Phase A Phil landing (parallel to legacy public/phil.html which
 * keeps serving /phil via vercel.json).
 *
 * Per docs/rebuild-audit/08-next-claude-code-prompt.md §G, "Today" and "More"
 * are live placeholders; Jobs/Gear/Snag are UNDER CONSTRUCTION.
 */
export default function PhilV2HomePage() {
  return (
    <PhilShell title="Phil">
      <div className="space-y-4">
        <Card>
          <CardTitle>Today</CardTitle>
          <CardDescription>
            This is the new Phil shell. The hours pipeline, gear handover, snag raising
            and job interface land in Phase B+ — Phase A is the navigation skeleton only.
          </CardDescription>
        </Card>

        <UnderConstructionPanel
          feature="Hours logging"
          description="One-tap Standard day (7h 36m) plus a custom-hours fallback. Lands in Phase B with the existing /api/time-entries backend."
          legacyHref="/my-day"
          legacyLabel="Use the legacy My day page"
        />
      </div>
    </PhilShell>
  );
}
