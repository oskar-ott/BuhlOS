/**
 * Pure greeting selectors for the Phil "My Day" header.
 *
 * The personalised welcome ("Arvo, Sam" · "Fri 12 Jun · on Birdwood Estate")
 * is composed here so the page stays a thin caller and the behaviour is
 * unit-testable. Inputs are plain values — the caller resolves the worker's
 * display name and the current hour; nothing here touches the clock, the
 * session, or the network.
 *
 * Display-name convention: users.json usernames double as human display
 * names across the app — the hours pipeline stamps `userName: user.username`
 * (api/time-entries.js) and the onboarding bridge splits `username` into
 * first/last (api/employees.js mapUserToEmployee). The greeting follows the
 * same convention: first whitespace token = first name. Names are rendered
 * as stored — never re-cased, never invented. A missing name degrades to the
 * impersonal part-of-day greeting, not a placeholder.
 *
 * Cross-ref: docs/phil-my-day.md §Greeting · src/app/phil/my-day/page.tsx
 */

export type PhilGreeting = {
  /** "Arvo, Sam" — or just "Arvo" when no display name is known. */
  heading: string;
  /** "Fri 12 Jun · on Birdwood Estate" — or just the date with 0/2+ jobs. */
  subtitle: string;
  /** "SP" avatar initials, or null when no display name is known. */
  initials: string | null;
};

export type PhilGreetingInput = {
  /** The worker's display name (full, as stored), or null when unknown. */
  displayName: string | null;
  /** Hour of day 0–23, already in the business timezone. */
  hour: number;
  /** Pre-formatted date label, e.g. "Fri 12 Jun". */
  dateLabel: string;
  /**
   * The single assigned job's name, or null. The "on {job}" tail is only
   * shown when the worker has exactly one assigned job — there is no
   * active-job signal in the data, so we never guess which site they're on.
   */
  soleJobName: string | null;
};

/**
 * "Morning" / "Arvo" / "Evening" buckets (Australian register, per the
 * design mock). Boundaries: <12 Morning · 12–16 Arvo · ≥17 Evening.
 * A non-finite hour falls back to "Morning" (matches the previous inline
 * behaviour when Intl returned something unparseable).
 */
export function partOfDayForHour(hour: number): "Morning" | "Arvo" | "Evening" {
  if (!Number.isFinite(hour) || hour < 12) return "Morning";
  if (hour < 17) return "Arvo";
  return "Evening";
}

/** First whitespace token of the display name, or null. */
export function firstNameFrom(displayName: string | null | undefined): string | null {
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * Up-to-two-letter avatar initials: first+last token initials ("Sam Patel"
 * → "SP"), or the first two characters of a single-token name ("sam" →
 * "SA"). Null when there's no name — the caller hides the avatar rather
 * than showing a placeholder.
 */
export function workerInitials(displayName: string | null | undefined): string | null {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Hour-of-day (0–23) for a Date in a named timezone. Normalises the ICU
 * "24:00" midnight quirk (hourCycle h24) back to 0 so midnight greets as
 * Morning, not Evening.
 */
export function hourInTimeZone(date: Date, timeZone: string): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).format(date)
  );
  return hour === 24 ? 0 : hour;
}

/** Compose the My Day header greeting from already-resolved inputs. */
export function buildPhilGreeting(input: PhilGreetingInput): PhilGreeting {
  const partOfDay = partOfDayForHour(input.hour);
  const firstName = firstNameFrom(input.displayName);
  const heading = firstName ? `${partOfDay}, ${firstName}` : partOfDay;
  const subtitle = input.soleJobName
    ? `${input.dateLabel} · on ${input.soleJobName}`
    : input.dateLabel;
  return { heading, subtitle, initials: workerInitials(input.displayName) };
}
