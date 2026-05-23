import { cn } from "@/lib/cn";

interface UnderConstructionPanelProps {
  feature: string;
  description?: string;
  /**
   * Optional link to the equivalent legacy surface so users can still get
   * work done while the new surface is being built.
   *
   * Legacy URLs are owned by vercel.json rewrites (not Next.js routes),
   * so this uses a plain anchor — typedRoutes does not apply and a hard
   * navigation is the honest behaviour (the destination is a separate SPA).
   */
  legacyHref?: string;
  legacyLabel?: string;
  className?: string;
}

/**
 * The canonical UNDER CONSTRUCTION placeholder.
 *
 * Used everywhere a feature is referenced from navigation but not yet
 * wired up. Per non-negotiable §"Feature gating", every incomplete feature
 * must show this; never an alert, never a blank page, never a fake stub.
 *
 * The yellow/black tape pattern is defined in src/styles/globals.css (.uc-tape).
 */
export function UnderConstructionPanel({
  feature,
  description,
  legacyHref,
  legacyLabel,
  className,
}: UnderConstructionPanelProps) {
  return (
    <section
      role="region"
      aria-label={`${feature} — under construction`}
      className={cn("overflow-hidden rounded-card border border-border bg-surface-raised", className)}
    >
      <div aria-hidden="true" className="uc-tape h-3 w-full" />
      <div className="p-8 text-center">
        <p className="font-display text-xs uppercase tracking-widest text-text-muted">
          Under construction
        </p>
        <h2 className="mt-2 font-display text-2xl text-text">{feature}</h2>
        {description ? (
          <p className="mx-auto mt-3 max-w-lg text-sm text-text-muted">{description}</p>
        ) : (
          <p className="mx-auto mt-3 max-w-lg text-sm text-text-muted">
            This surface is being rebuilt. The audit-driven Phase A scaffold is in place;
            the working implementation lands in a later phase.
          </p>
        )}
        {legacyHref && legacyLabel ? (
          <p className="mt-4 text-sm">
            <a
              href={legacyHref}
              className="underline decoration-accent-yellow decoration-2 underline-offset-4 hover:text-brand-navy"
            >
              {legacyLabel}
            </a>
          </p>
        ) : null}
      </div>
      <div aria-hidden="true" className="uc-tape h-3 w-full" />
    </section>
  );
}
