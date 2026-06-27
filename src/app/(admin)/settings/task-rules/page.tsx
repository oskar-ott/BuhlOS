import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { TaskRulesEditor } from "@/components/admin/TaskRulesEditor";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

/**
 * /settings/task-rules (#224) — maintain the rule-based task-generation rules.
 *
 * A rule ("every bathroom gets these 8 rough-in tasks") lives here instead of in
 * an admin's head; the builder's "Generate tasks" applies them to a job's empty
 * areas. Admin-tier gated via the normalised-role surface check (same pattern as
 * /settings/notifications) — never a literal 'admin' comparison. The endpoints
 * (api/task-rules.js, api/generate-tasks.js) enforce admin server-side too.
 *
 * The editor is a self-fetching client island; the page is just the shell + gate.
 */
export default async function TaskRulesSettingsPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/settings/task-rules");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  return (
    <AdminShell title="Task generation rules">
      <div className="mx-auto max-w-3xl space-y-6">
        <Card>
          <CardTitle>Task generation rules</CardTitle>
          <CardDescription className="mt-1">
            Capture the repeatable task lists that live in your head — by job type,
            by area name, or both — so a new structure starts with the right tasks
            instead of empty areas. These are deterministic rules, not AI: the same
            job and rules always produce the same starting point, which you then
            edit for exceptions.
          </CardDescription>
        </Card>

        <section aria-label="Task generation rules">
          <TaskRulesEditor />
        </section>
      </div>
    </AdminShell>
  );
}
