"use client";

import { useEffect, useState, useTransition } from "react";
import { landingFor } from "@/lib/auth/landing";
import { migrateLocalStorage } from "@/lib/storage/migrate-local-storage";
import styles from "./login.module.css";

interface LoginFormProps {
  next?: string;
}

/**
 * The BuhlOS sign-in card (right side of the split layout). Recreated from the
 * Claude Design handoff (buhlos-phil/project/login/login.jsx).
 *
 * Wiring is real, not prototype: POSTs to the existing /api/auth?action=login
 * endpoint with `{ username, secret }` (the shape api/auth.js destructures —
 * see the earlier draft's 400 "username and secret required" bug). The endpoint
 * sets the buhl_session cookie; on success we HARD-navigate so the new cookie is
 * observed by middleware on the next request. landingFor() is the SAME source of
 * truth used by src/middleware.ts (no second copy — non-negotiable §"One
 * canonical source per concept").
 *
 * Intentional deviations from the prototype, agreed with the user:
 *   • "Forgot password" — dropped (no self-service reset backend yet; the
 *     prototype's "email reset link" screen was a mock).
 *   • SSO — shown disabled / "coming soon" (no SSO/SAML/OAuth backend exists).
 *   • Dark / HC themes, centered layout, the Tweaks panel and the success/locked
 *     preview states — design-review controls, not shipped.
 *
 * The data-testid hooks (login-username / login-password / login-submit) and the
 * "Sign in" button name are load-bearing: the field-readiness smoke + auth-routing
 * specs drive login through them (tests/playwright/helpers/auth.ts).
 */
export function LoginForm({ next }: LoginFormProps) {
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // One-time cleanup of deprecated "buhl-site-office-*" localStorage keys.
    migrateLocalStorage();
  }, []);

  const idErr = touched && !identifier.trim() ? "Enter your work email" : "";
  const pwErr = touched && !secret ? "Enter your password" : "";

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!identifier.trim() || !secret) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth?action=login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          // api/auth.js destructures { username, secret } — must match.
          body: JSON.stringify({ username: identifier, secret }),
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Sign-in failed (${res.status}).`);
          return;
        }
        const body = (await res.json()) as { user?: { role?: string } };
        const target = next && next.startsWith("/") ? next : landingFor(body.user?.role);
        // Hard navigation so the new session cookie is read by the middleware.
        window.location.assign(target);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error.");
      }
    });
  }

  const banner = error ? bannerFor(error) : null;

  return (
    <div className={styles.card}>
      <div className={styles.topmark}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.topmarkLogo} src="/brand/buhl-logo-ink.png" alt="bühl electrical" />
      </div>

      <span className={styles.eyebrow}>Sign in</span>
      <h2 className={styles.h}>Welcome back.</h2>
      <p className={styles.p}>Sign in to your bühl electrical workspace.</p>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {banner && (
          <div className={styles.banner} role="alert">
            <div className={styles.ic}>!</div>
            <div>
              <b>{banner.title}</b>
              <p>{banner.detail}</p>
            </div>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-email">
            <span>Work email</span>
          </label>
          <div className={styles.inputWrap}>
            <input
              id="login-email"
              data-testid="login-username"
              className={`${styles.input} ${idErr ? styles.err : ""}`}
              type="text"
              name="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@bühl.com.au"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoFocus
            />
          </div>
          {idErr && <span className={styles.msg}>! {idErr}</span>}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-password">
            <span>Password</span>
          </label>
          <div className={styles.inputWrap}>
            <input
              id="login-password"
              data-testid="login-password"
              className={`${styles.input} ${styles.hasEye} ${pwErr ? styles.err : ""}`}
              type={show ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              spellCheck={false}
              placeholder="••••••••"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <button
              type="button"
              className={styles.eye}
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
          {pwErr && <span className={styles.msg}>! {pwErr}</span>}
        </div>

        <button
          type="submit"
          data-testid="login-submit"
          className={`${styles.submit} ${pending ? styles.busy : ""}`}
          disabled={pending}
        >
          {pending ? (
            <>
              <span className={styles.spinner} />Signing in…
            </>
          ) : (
            <>Sign in →</>
          )}
        </button>

        <div className={styles.or}>or</div>
        <button type="button" className={styles.sso} disabled aria-disabled="true">
          <span className={styles.key}>⌘</span>Use single sign-on (SSO)
        </button>
        <p className={styles.ssoNote}>SSO coming soon — sign in with your email for now</p>
      </form>

      <div className={styles.foot}>
        Field crew? You use <b>Phil</b> on your phone — not here.
        <br />
        Trouble signing in? Call the office on <b>0421 558 902</b>.
      </div>
    </div>
  );
}

/** Map a raw /api/auth error into the banner's title + detail. */
function bannerFor(message: string): { title: string; detail: string } {
  const m = message.toLowerCase();
  if (m.includes("disabled")) {
    return { title: "Account disabled", detail: "Ask your supervisor, or call the office to sort it out." };
  }
  if (m.includes("invalid credentials") || m.includes("incorrect")) {
    return { title: "Email or password incorrect", detail: "Check them and try again." };
  }
  return { title: "Couldn’t sign in", detail: message };
}
