interface PhilHeaderProps {
  title: string;
}

export function PhilHeader({ title }: PhilHeaderProps) {
  return (
    <header className="flex h-12 items-center justify-between gap-2 border-b border-border bg-brand-navy px-4 text-text-inverse">
      <p className="min-w-0 flex-1 truncate font-display text-base" title={title}>
        {title}
      </p>
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-pill bg-accent-yellow"
        title="Phil"
      />
    </header>
  );
}
