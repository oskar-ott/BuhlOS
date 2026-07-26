import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { JetBrains_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth/current-user";
import { landingFor } from "@/lib/auth/landing";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

/**
 * /v2/login — the BuhlOS sign-in.
 *
 * Lean-reset redesign (2026-07-26, owner-ratified replica): ONE centred
 * "Welcome back." card on the warm off-white ground — ink wordmark on top,
 * yellow underline accent, underline-style fields — with a mono footer strip
 * pinned to the bottom of the screen. The old split navy brand panel is gone.
 *
 * Already-logged-in users are bounced to their landing. Anyone else signs in
 * via LoginForm, which POSTs to the existing /api/auth?action=login endpoint.
 */

// The design uses JetBrains Mono for micro-labels / footers. It isn't in the
// global font set (root layout loads Inter + Inter Tight only), so load it
// route-scoped and expose it as --font-jetbrains-mono on the login container.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sign in · BuhlOS",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; mode?: string }>;
}) {
  const user = await getCurrentUser();
  // `as Route` — see src/app/page.tsx for the same Phase A cast rationale.
  if (user?.role) redirect(landingFor(user.role) as Route);
  const params = await searchParams;

  return (
    <div className={`${styles.login} ${jetbrainsMono.variable}`} data-testid="login-screen">
      <main className={styles.main}>
        <LoginForm next={params.next} initialMode={params.mode === "worker" ? "worker" : "office"} />
      </main>
      <footer className={styles.screenFoot}>
        <span>bühl electrical · Sydney</span>
        <span>
          Stuck? Call the office on <b>0421 558 902</b>
        </span>
      </footer>
    </div>
  );
}
