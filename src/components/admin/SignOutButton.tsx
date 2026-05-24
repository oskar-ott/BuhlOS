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
export function SignOutButton() {
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
      type="button"
      onClick={signOut}
      disabled={pending}
      className="flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm text-slate-300 hover:bg-accent-ink hover:text-text-inverse disabled:opacity-60"
    >
      <LogOut aria-hidden="true" className="h-4 w-4" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
