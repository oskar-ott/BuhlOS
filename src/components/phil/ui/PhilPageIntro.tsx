import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PhilPageIntroProps {
  /** Page title — rendered as the page's single <h1>. */
  title: string;
  /** Short, plain-English line under the title (the "what is this" cue). */
  description?: string;
  /** Trailing meta slot — assigned-count text, a RefreshButton, etc. */
  meta?: ReactNode;
  className?: string;
}

/**
 * Consistent titled intro for a Phil surface.
 *
 * The slim navy app bar (PhilHeader) is chrome; this is the in-body page
 * title + one-line description the "official product details" pass calls for.
 * Gives every list surface (Jobs / My day / Gear / Hours) the same hierarchy:
 * an h1 a step above the section CardTitles, with an optional meta slot on the
 * right for the live count or refresh control.
 */
export function PhilPageIntro({ title, description, meta, className }: PhilPageIntroProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="font-display text-xl font-semibold tracking-tight text-text">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-sm text-text-muted">{description}</p>
        ) : null}
      </div>
      {meta ? <div className="shrink-0 pt-1 text-right">{meta}</div> : null}
    </div>
  );
}
