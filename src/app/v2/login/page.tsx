import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { JetBrains_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth/current-user";
import { landingFor } from "@/lib/auth/landing";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

/**
 * /v2/login — the BuhlOS desktop sign-in.
 *
 * Implements the Claude Design handoff (buhlos-phil/project/BuhlOS Login.html):
 * a split layout — navy brand panel (left) + sign-in card (right). The card is
 * the interactive client component; everything here is static and server-rendered.
 *
 * Already-logged-in users are bounced to their landing. Anyone else signs in via
 * LoginForm, which POSTs to the existing /api/auth?action=login endpoint.
 *
 * Cross-ref: docs/rebuild-audit/08-next-claude-code-prompt.md §"For /login"
 */

// The design uses JetBrains Mono for eyebrows / labels / footers. It isn't in
// the global font set (root layout loads Inter + Inter Tight only), so load it
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
      <aside className={styles.brand}>
        <div className={styles.brandTop}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.brandLogo} src="/brand/buhl-logo-white.png" alt="bühl electrical" />
          <span className={styles.brandCo}>BuhlOS · Operations</span>
        </div>
        <div className={styles.brandMid}>
          <h1 className={styles.brandH}>
            Everything bühl <em>runs on.</em>
          </h1>
          <p className={styles.brandSub}>
            Jobs, hours, gear and the crew — the one place the bühl electrical office runs the
            day from.
          </p>
          <ul className={styles.brandPoints}>
            <li>
              <span className={styles.dot} />Sign off the crew&apos;s hours, ready for payroll
            </li>
            <li>
              <span className={styles.dot} />Every bühl job, snag and document in one place
            </li>
            <li>
              <span className={styles.dot} />Know which tool&apos;s on which site
            </li>
          </ul>
        </div>
        <div className={styles.brandFoot}>
          <span>bühl electrical · Sydney</span>
          <span>v1.0</span>
        </div>
      </aside>

      <main className={styles.main}>
        <LoginForm next={params.next} initialMode={params.mode === "worker" ? "worker" : "office"} />
      </main>
    </div>
  );
}
