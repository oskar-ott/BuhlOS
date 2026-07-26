"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Client portal sign-out control (#271 / Epic 16).
 *
 * Mirrors the admin/Phil sign-out flow: POSTs to `/api/auth?action=logout` (the
 * only method that clears the httpOnly `buhl_session` cookie — a GET anchor
 * leaves the session intact), then routes back to /v2/login. A network error is
 * non-fatal: the cookie clear is server-side and the middleware bounces any
 * still-valid session, so the visitor lands on login regardless.
 *
 * Deliberately minimal — the portal is an external-customer surface with no
 * Phil page-cache or per-worker prefs to purge.
 */
export function PortalSignOutButton({ className }: { className?: string }) {
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
      // Best-effort — the middleware redirects a still-valid session to login.
    }
    router.replace("/v2/login");
    router.refresh();
  }

  return (
    <button
      data-testid="portal-logout"
      type="button"
      onClick={signOut}
      disabled={pending}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full",
        "px-3 py-1.5 text-xs font-semibold text-white/90",
        "transition hover:bg-white/10 active:scale-[0.98]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
