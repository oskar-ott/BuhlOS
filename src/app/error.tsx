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
    // In real prod we'd report this with a unique error ID; Phase A logs only.
    console.error("[BuhlOS] unhandled error:", error);
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
