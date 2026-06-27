"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { purgePhilPageCaches } from "@/domains/phil/page-cache";
import { purgeJobListPrefs } from "./jobListPrefs";

/**
 * Phil sign-out control.
 *
 * Mirrors the admin SignOutButton flow: POSTs to `/api/auth?action=logout`
 * (the only method that actually clears the httpOnly `buhl_session` cookie — a
 * GET anchor leaves the session intact and dumps the worker on a JSON page),
 * then routes back to /v2/login. A network error is non-fatal: the cookie
 * clear is best-effort and the middleware bounces any still-valid session back
 * to login, so we send the worker to the login screen regardless.
 *
 * Styled as a neutral full-width control rather than the yellow
 * PhilActionButton — accent-yellow is reserved for the single primary field
 * action per screen, and signing out is a deliberate secondary action.
 *
 * `userId` (optional) keys the client-only recent + pinned jobs prefs (#145);
 * we purge them on sign-out so a shared device never leaks the previous
 * worker's list to the next person. Absent userId → nothing to purge.
 */
export function PhilSignOutButton({
  className,
  userId,
}: {
  className?: string;
  userId?: string;
}) {
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
      // Best-effort — the cookie clear is server-side and the middleware will
      // redirect a still-valid session back to login, so a network blip here
      // doesn't strand the worker.
    }
    // Clear the offline page cache so a shared device never serves this
    // worker's cached /phil pages to the next person (#135 Layer 2).
    await purgePhilPageCaches();
    // Drop this worker's recent + pinned jobs (#145) for the same shared-device
    // reason — best-effort, client-only, keyed by userId.
    if (userId) purgeJobListPrefs(userId);
    router.replace("/v2/login");
    router.refresh();
  }

  return (
    <button
      data-testid="phil-logout"
      type="button"
      onClick={signOut}
      disabled={pending}
      className={cn(
        "inline-flex h-12 w-full items-center justify-center gap-2 rounded-card",
        "border border-border bg-surface-raised text-sm font-semibold text-text",
        "transition hover:bg-surface-subtle active:scale-[0.99]",
        "focus-visible:outline-brand-navy",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
        className,
      )}
    >
      <LogOut aria-hidden="true" className="h-4 w-4" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
