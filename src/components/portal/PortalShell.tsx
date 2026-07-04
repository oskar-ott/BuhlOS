import type { ReactNode } from "react";
import { PortalSignOutButton } from "./PortalSignOutButton";

interface PortalShellProps {
  children: ReactNode;
  /** Shown in the header — the job name on a detail page, or a greeting. */
  title: string;
  /** Optional back-link href (e.g. from a job page back to the list). */
  backHref?: string;
  backLabel?: string;
}

/**
 * The client portal shell (#271 / Epic 16).
 *
 * This is its OWN surface — neither AdminShell (office desktop chrome) nor
 * PhilShell (field tab bar). Clients are external customers; the portal is a
 * calm, read-only, mobile-first page with a single job in view and nothing to
 * do but read. No sidebar, no tab bar, no ⌘K, no capture FAB.
 *
 * The modern replacement for the kept static /client page (route-ownership
 * §12.1); the cutover that retires public/client.html is a separate final PR.
 */
export function PortalShell({ children, title, backHref, backLabel }: PortalShellProps) {
  return (
    <div
      data-testid="client-portal-shell"
      className="mx-auto flex min-h-screen w-full max-w-lg flex-col bg-surface-subtle"
    >
      <header className="sticky top-0 z-10 bg-brand-navy px-4 py-3 text-white shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-white/60">
              Your projects
            </p>
            <h1 className="truncate text-base font-semibold text-white">{title}</h1>
          </div>
          <PortalSignOutButton />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
        {backHref ? (
          <a
            href={backHref}
            className="inline-flex w-fit items-center gap-1 text-sm font-medium text-brand-navy hover:underline"
          >
            <span aria-hidden="true">&larr;</span>
            {backLabel || "Back"}
          </a>
        ) : null}
        {children}
      </main>

      <footer className="px-4 py-6 text-center text-xs text-text-muted">
        Read-only project view. For questions, contact your builder.
      </footer>
    </div>
  );
}
