import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="font-display text-xl text-text">Not found</h1>
      <p className="text-sm text-text-muted">This page doesn&rsquo;t exist (yet).</p>
      <Link
        href="/v2/login"
        className="text-sm font-medium underline decoration-accent-yellow decoration-2 underline-offset-4"
      >
        Sign in
      </Link>
    </main>
  );
}
