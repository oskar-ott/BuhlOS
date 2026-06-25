"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Sidebar sign-out control. POSTs to `/api/auth?action=logout` (the only
 * method the endpoint honours — a GET anchor leaves the session intact and
 * dumps the user on a JSON page) and routes back to /v2/login on success.
 *
 * Falls back to a full navigation if router.push doesn't trip the middleware
 * — without that, the user could land on a stale client-side cached page.
 */
/**
 * Default styling targets the dark navy sidebar (slate-300 on navy). The mobile
 * nav drawer has a light background, so it passes a light-theme `className` and
 * a distinct `testId` (the Playwright logout helper targets the sidebar's
 * `data-testid="logout"`; a second identical id would break its strict match).
 */
const SIDEBAR_CLASS =
  "flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm text-slate-300 hover:bg-accent-ink hover:text-text-inverse disabled:opacity-60";

export function SignOutButton({
  className,
  testId = "logout",
}: {
  className?: string;
  testId?: string;
} = {}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth?action=logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // Network error doesn't matter — the cookie is best-effort and we
      // still send the user to /v2/login. The middleware will redirect
      // back if the cookie is still valid.
    }
    router.replace("/v2/login");
    router.refresh();
  }

  return (
    <button
      data-testid={testId}
      type="button"
      onClick={signOut}
      disabled={pending}
      className={className ?? SIDEBAR_CLASS}
    >
      <LogOut aria-hidden="true" className="h-4 w-4" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
