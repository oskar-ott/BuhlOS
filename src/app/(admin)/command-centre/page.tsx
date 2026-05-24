import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";

/**
 * /command-centre — Phase A BuhlOS admin landing.
 *
 * Placeholder per docs/rebuild-audit/08-next-claude-code-prompt.md §F:
 *   "Welcome to BuhlOS Admin. Hours loop coming next."
 *
 * The shell (sidebar + topbar) is real; the content is intentionally minimal.
 * Phase B adds the hours-approvals widget here.
 */
export default function CommandCentrePage() {
  return (
    <AdminShell title="Command Centre" breadcrumb="Phase A · shell only">
      <div className="mx-auto max-w-3xl space-y-4">
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Welcome to BuhlOS Admin</CardTitle>
              <CardDescription>
                You&rsquo;re looking at the new admin shell. The hours loop, snags, approvals,
                and the rest of the Command Centre land in Phase B and beyond — the audit
                deliberately scopes Phase A to foundation only.
              </CardDescription>
            </div>
            <StatusBadge status="v1" />
          </div>
        </Card>

        <Card>
          <CardTitle>What&rsquo;s next</CardTitle>
          <ul className="mt-3 space-y-2 text-sm text-text-muted">
            <li>
              <span className="font-medium text-text">Phase B · hours loop.</span> Worker
              submits hours → admin approves → weekly summary → CSV export.
            </li>
            <li>
              <span className="font-medium text-text">Phase C · gear loop.</span> Admin
              assigns gear → worker returns or reports damaged / missing → admin sees
              status with full audit history.
            </li>
            <li>
              <span className="font-medium text-text">Phase D+ · evidence, ITP, materials, plans.</span>{" "}
              Per the MVP rebuild scope.
            </li>
          </ul>
        </Card>

        <Card>
          <CardTitle>Legacy still authoritative</CardTitle>
          <CardDescription>
            All existing admin pages remain reachable at their canonical legacy URLs
            (<code className="text-xs">/admin/operations</code>,{" "}
            <code className="text-xs">/admin/jobs</code>, etc.) through vercel.json rewrites.
            Nothing in production is changed by Phase A.
          </CardDescription>
        </Card>
      </div>
    </AdminShell>
  );
}
