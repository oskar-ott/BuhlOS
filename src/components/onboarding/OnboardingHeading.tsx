interface OnboardingHeadingProps {
  eyebrow?: string;
  title: string;
  sub?: string;
}

/**
 * Eyebrow + title + sub block used on every step page beyond Welcome.
 * Type & spacing tracks the design handoff:
 *   - Eyebrow: mono 10px, .14em tracking, uppercase
 *   - Title:   Inter Tight 700, ~26px, -0.026em letter-spacing
 *   - Sub:     Inter 400, 14.5px, 1.5 line-height
 */
export function OnboardingHeading({ eyebrow, title, sub }: OnboardingHeadingProps) {
  return (
    <header className="px-5 pb-2 pt-5">
      {eyebrow ? (
        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="font-display text-[26px] font-bold leading-[1.1] tracking-tight text-text [text-wrap:balance]">
        {title}
      </h1>
      {sub ? (
        <p className="mt-2 text-[15px] leading-snug text-text-muted [text-wrap:pretty]">
          {sub}
        </p>
      ) : null}
    </header>
  );
}
