import { redirect } from "next/navigation";
import type { Route } from "next";
import { getCurrentUser } from "@/lib/auth/current-user";
import { landingFor } from "@/lib/auth/landing";
import { LoginForm } from "./login-form";

/**
 * /v2/login — the new Phase A login surface, parallel to legacy public/login.html.
 *
 * Already-logged-in users are bounced to their landing. Anyone else sees the
 * new LoginForm, which POSTs to the existing /api/auth?action=login endpoint.
 *
 * Cross-ref: docs/rebuild-audit/08-next-claude-code-prompt.md §"For /login"
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  // `as Route` — see src/app/page.tsx for the same Phase A cast rationale.
  if (user?.role) redirect(landingFor(user.role) as Route);
  const params = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6">
      <div className="w-full">
        <header className="mb-6 text-center">
          <p className="font-display text-xs uppercase tracking-widest text-text-muted">
            BuhlOS · v2
          </p>
          <h1 className="mt-2 font-display text-2xl text-text">Sign in</h1>
          <p className="mt-1 text-sm text-text-muted">
            Parallel login for the new shell. The legacy <code className="text-xs">/login</code>{" "}
            stays active during Phase A.
          </p>
        </header>
        <LoginForm next={params.next} />
      </div>
    </main>
  );
}
