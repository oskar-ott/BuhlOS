import { buildPhilNeedsYou } from "@/domains/phil/needs-you";
import type { TimeEntry } from "@/domains/timesheets/types";
import { loadHeldCalibrations } from "./PhilNeedsYouSection";
import { PhilMyDayDoThisNow } from "./PhilMyDaySharpened";
import { PhilSkeleton } from "./ui/PhilSkeleton";

/**
 * Streamed "Do this now" + "Needs you" section for the SHARPENED My Day
 * (phil_sharpened, dark).
 *
 * Same streaming shape as the current screen's PhilNeedsYouSection (which it
 * shares its loaders with): calibrations are a separate read, i.e. a SECOND
 * data wave of ~1.3–2.1s Blob round-trips
 * (#670). Rendering inside <Suspense> lets the sharpened shell (greeting,
 * job card, quick grid) paint on wave one and this section stream in — never
 * a blank screen, never a fabricated interim row.
 *
 * The full sorted needs-you list goes to PhilMyDayDoThisNow, which renders
 * items[0] as the hero and the rest as the list — one model, one source of
 * truth (buildPhilNeedsYou), zero invented urgency (P7).
 */
export async function PhilMyDaySharpenedAttention({
  cookieValue,
  viewerId,
  entries,
}: {
  cookieValue: string | undefined;
  viewerId: string | null;
  entries: ReadonlyArray<TimeEntry>;
}) {
  const calibrations = await loadHeldCalibrations(cookieValue);
  const items = buildPhilNeedsYou({ viewerId, entries, calibrations });
  return <PhilMyDayDoThisNow items={items} />;
}

/** Honest loading shimmer: a hero-sized block + two faint rows. Never implies
 *  specific items; resolves to the real section (or its honest all-clear). */
export function PhilMyDaySharpenedAttentionFallback() {
  return (
    <section aria-label="Do this now" aria-busy="true" aria-live="polite">
      <span className="sr-only">Checking what needs you…</span>
      <PhilSkeleton className="h-32 w-full rounded-card" />
      <div className="mt-3 space-y-2">
        <PhilSkeleton className="h-12 w-full rounded-card" />
        <PhilSkeleton className="h-12 w-full rounded-card" />
      </div>
    </section>
  );
}
