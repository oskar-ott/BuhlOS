import { redirect } from "next/navigation";

/**
 * /hours — the hours section root now LANDS on the weekly board.
 *
 * Owner directive (2026-08-08): the crew logs hours weekly — often the whole
 * week at the end of it — so the section opens on the Mon–Sun week. The day
 * view was removed outright on 2026-08-09 (it only re-projected the same
 * week); /hours/today is now a redirect here too. Every deep link to /hours
 * keeps working via this redirect, so the URL stays sacred.
 *
 * `?week=` (any date inside the desired week) is forwarded — /hours/weekly
 * reads the same convention — so old week-scoped links land on the right week.
 */
export default async function HoursSectionRoot({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const sp = await searchParams;
  const week =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  redirect(week ? `/hours/weekly?week=${week}` : "/hours/weekly");
}
