import { redirect } from "next/navigation";

/**
 * /hours/today — removed (owner directive 2026-08-09).
 *
 * The crew logs hours weekly, not daily, so a day-shaped admin view only
 * muddied the section: everything it showed was a projection of the same
 * week the board already answers. The route stays alive as a redirect so
 * every old link keeps working (URLs are sacred); the leave-approvals card
 * — the one thing that lived only here — moved to /hours/weekly, where
 * marking leave is what clears a missing day.
 *
 * `?week=` is forwarded — /hours/weekly reads the same convention — so any
 * week-scoped deep link lands on the right week.
 */
export default async function HoursTodayRedirect({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const sp = await searchParams;
  const week = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  redirect(week ? `/hours/weekly?week=${week}` : "/hours/weekly");
}
