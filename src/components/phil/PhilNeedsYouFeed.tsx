import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/cn";
import styles from "./myDay.module.css";
import type { PhilNeedsYouItem, PhilNeedsYouSeverity } from "@/domains/phil/needs-you";

const DOT: Record<PhilNeedsYouSeverity, string | undefined> = {
  urgent: styles.urgent,
  warning: styles.warning,
  normal: undefined,
};

/**
 * Phil My Day "Needs you" feed — the worker's real, actionable attention items
 * (see buildPhilNeedsYou). Every row links to a real in-app route; when there
 * is nothing real, it shows an honest empty state rather than a fabricated row.
 * Quiet and field-scannable, sitting below the hours area on /phil/my-day.
 */
export function PhilNeedsYouFeed({ items }: { items: ReadonlyArray<PhilNeedsYouItem> }) {
  if (items.length === 0) {
    return (
      <section className={styles.needsEmpty} aria-label="Needs you">
        <p className={styles.needsEmptyTitle}>Nothing needs you right now</p>
        <p className={styles.needsEmptyBody}>You&rsquo;re clear for today.</p>
      </section>
    );
  }

  return (
    <section className={styles.needs} aria-label="Needs you">
      <div className={styles.needsHead}>
        <span className={styles.needsTitle}>Needs you</span>
        <span className={styles.needsCount}>{items.length}</span>
      </div>
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <Link href={it.href as Route} className={styles.needsRow}>
              <span
                className={cn(styles.needsDot, DOT[it.severity])}
                aria-hidden="true"
              />
              <span className={styles.needsText}>
                <span className={styles.needsItemTitle}>{it.title}</span>
                {it.detail ? (
                  <span className={styles.needsItemDetail}>{it.detail}</span>
                ) : null}
              </span>
              <span className={styles.needsAction}>{it.actionLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
