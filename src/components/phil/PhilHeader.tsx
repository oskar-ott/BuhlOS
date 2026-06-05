interface PhilHeaderProps {
  title: string;
}

/**
 * Phil top app bar — slim navy chrome with the page title and the brand
 * accent dot. Stays put while `<main>` scrolls (it's a flex sibling of the
 * scroll container), so it reads as a fixed app bar.
 *
 * Refinements over the flat original: a top safe-area inset so the bar
 * clears a notch / status bar, a subtle elevation so it sits above the
 * grey content surface, and tighter title typography.
 */
export function PhilHeader({ title }: PhilHeaderProps) {
  return (
    <header className="shrink-0 bg-brand-navy text-text-inverse shadow-card pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 items-center justify-between gap-2 px-4">
        <p
          className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight"
          title={title}
        >
          {title}
        </p>
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-pill bg-accent-yellow"
          title="Phil"
        />
      </div>
    </header>
  );
}
