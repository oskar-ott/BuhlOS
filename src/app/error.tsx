"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Root error boundary. Renders for any unhandled error in a server or
 * client component below it.
 *
 * No alert(), no inline styles, no DOM replacement — proper React per
 * docs/architecture/00-rebuild-non-negotiables.md §UI.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[BuhlOS] unhandled error:", error);
    // #154: best-effort report to the platform error journal (Owner Console).
    // Fire-and-forget — a failed report must never affect the error UI.
    try {
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message || "unknown client error",
          stack: error.stack ? String(error.stack).slice(0, 800) : undefined,
          digest: error.digest,
          url: window.location.pathname,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Never let reporting break the boundary itself.
    }
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-display text-xl text-text">Something broke.</h1>
      <p className="text-sm text-text-muted">
        {error.message || "An unexpected error occurred."}
        {error.digest ? <span className="block text-xs">ref: {error.digest}</span> : null}
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
