import type { Route } from "next";
import { ArrowRight, CheckCircle2, Clock, TriangleAlert } from "lucide-react";
import type { MyDayHero, MyDayHeroTone } from "@/domains/phil/my-day-hero";
import styles from "./myDay.module.css";
import { cn } from "@/lib/cn";
import { PhilOfflineLink } from "./PhilOfflineLink";

/**
 * My Day hero (#422) — the one "what now" answer, rendered from the pure
 * state model. One card, status-bearing line ≥14px, in the app's global
 * dialect (#423). When the action is logging today, the card points at the
 * log sheet right below it (no link); otherwise it carries a deep-link chip.
 */

const TONE_ICON: Record<MyDayHeroTone, typeof Clock> = {
  danger: TriangleAlert,
  action: Clock,
  info: ArrowRight,
  success: CheckCircle2,
};

export function PhilMyDayHero({ hero }: { hero: MyDayHero }) {
  const Icon = TONE_ICON[hero.tone];
  return (
    <section
      className={cn(styles.hero, styles[`hero_${hero.tone}`])}
      aria-label="What now"
      data-testid="my-day-hero"
      data-hero-kind={hero.kind}
    >
      <div className={styles.heroIcon} aria-hidden="true">
        <Icon className="h-5 w-5" />
      </div>
      <div className={styles.heroBody}>
        <p className={styles.heroTitle}>{hero.title}</p>
        <p className={styles.heroDetail}>{hero.detail}</p>
        {hero.actionLabel && hero.href ? (
          <PhilOfflineLink href={hero.href as Route} className={styles.heroAction} data-testid="my-day-hero-action">
            {hero.actionLabel}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </PhilOfflineLink>
        ) : null}
      </div>
    </section>
  );
}
