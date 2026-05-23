interface PhilHeaderProps {
  title: string;
}

export function PhilHeader({ title }: PhilHeaderProps) {
  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-brand-navy px-4 text-text-inverse">
      <p className="font-display text-base">{title}</p>
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-pill bg-accent-yellow"
        title="Phil"
      />
    </header>
  );
}
