import Link from "next/link";

/**
 * 404 / not-found surface.
 *
 * Two recovery paths: Home (/) routes through the auth landing helper and
 * sends the user to their proper surface (Phil for field, Command Centre
 * for admin), or fall through to /v2/login if they have no session. Sign
 * in is offered as a secondary path for someone who knows their session
 * has expired.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-display text-xl text-text">We couldn&rsquo;t find that page</h1>
      <p className="text-sm text-text-muted">
        The link may be out of date, or the surface isn&rsquo;t built yet.
        Head back home and pick up from there.
      </p>
      <div className="mt-2 flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
        <Link
          href="/"
          className="inline-flex h-11 items-center justify-center rounded-card bg-brand-navy px-5 text-sm font-medium text-text-inverse hover:bg-accent-ink"
        >
          Home
        </Link>
        <Link
          href="/v2/login"
          className="text-sm font-medium underline decoration-accent-yellow decoration-2 underline-offset-4"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
