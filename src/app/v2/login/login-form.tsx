"use client";

import { useEffect, useState, useTransition } from "react";
import { landingFor } from "@/lib/auth/landing";
import { migrateLocalStorage } from "@/lib/storage/migrate-local-storage";
import { purgePhilPageCaches } from "@/domains/phil/page-cache";
import styles from "./login.module.css";

interface LoginFormProps {
  next?: string;
  /** #421: deep-link straight into worker (name+PIN) mode via ?mode=worker —
   *  e.g. from the invite-accepted screen. Defaults to the office form. */
  initialMode?: "office" | "worker";
}

/**
 * The BuhlOS sign-in card — the centred "Welcome back." card of the lean-reset
 * redesign (2026-07-26, owner-ratified replica).
 *
 * Two modes share the same credential model and the same POST to
 * /api/auth?action=login with `{ username, secret }`:
 *   • OFFICE (default) — the email + password form. The "Welcome back." /
 *     "Work email" strings and the login-username / login-password /
 *     login-submit testids are load-bearing (field-readiness + auth-routing
 *     smoke). Do not touch them.
 *   • WORKER (#421, email-first 2026-07-28) — email + 4-digit PIN on big
 *     glove-friendly keys, no office dialect ("Work email"/"Password" never
 *     appear). Same POST, distinct worker-* testids so the office smoke is
 *     unaffected. Legacy crew who know a NAME username can still type it —
 *     api/auth.js matches exact username first, then the email field.
 *
 * Intentional deviations from the replica:
 *   • "Forgot your password?" — omitted (no self-service reset backend; a dead
 *     link would break the honest-UI rule). The screen footer's office phone
 *     is the real recovery path.
 */
export function LoginForm({ next, initialMode = "office" }: LoginFormProps) {
  const [mode, setMode] = useState<"office" | "worker">(initialMode);
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

  /** Shared sign-in: posts { username, secret } and navigates on success.
   *  onFail lets each mode shape its own retry behaviour. */
  function signIn(username: string, pin: string, onFail: (msg: string) => void) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/auth?action=login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          // api/auth.js destructures { username, secret } — must match.
          body: JSON.stringify({ username, secret: pin }),
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          onFail(body.error ?? `Sign-in failed (${res.status}).`);
          return;
        }
        const body = (await res.json()) as { user?: { role?: string } };
        // Wipe any offline /phil page cache left by a PREVIOUS worker on this
        // (possibly shared) device before the new session loads its own pages
        // (#575 P1a). Sign-in is the boundary that holds even when no explicit
        // sign-out ran — cookie expiry or app kill — because taking over the
        // device requires logging in. Best-effort and never throws.
        await purgePhilPageCaches();
        const target = next && next.startsWith("/") ? next : landingFor(body.user?.role);
        // Hard navigation so the new session cookie is read by the middleware.
        window.location.assign(target);
      } catch (err) {
        onFail(err instanceof Error ? err.message : "Network error.");
      }
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (!identifier.trim() || !secret) return;
    signIn(identifier, secret, (msg) => setError(msg));
  }

  if (mode === "worker") {
    return (
      <WorkerSignIn
        pending={pending}
        error={error}
        onBack={() => {
          setMode("office");
          setError(null);
        }}
        onSubmit={(name, pin, clearPin) =>
          signIn(name, pin, (msg) => {
            setError(msg);
            clearPin();
          })
        }
      />
    );
  }

  const banner = error ? bannerFor(error) : null;

  return (
    <div className={styles.card}>
      <div className={styles.topmark}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.topmarkLogo} src="/brand/buhl-logo-ink.png" alt="bühl electrical" />
      </div>

      <h2 className={styles.h}>Welcome back.</h2>
      <div className={styles.accentBar} aria-hidden="true" />

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
          <div className={styles.labelRow}>
            <label className={styles.label} htmlFor="login-password">
              <span>Password</span>
            </label>
            <button
              type="button"
              className={styles.eye}
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? "Hide" : "Show"}
            </button>
          </div>
          <div className={styles.inputWrap}>
            <input
              id="login-password"
              data-testid="login-password"
              className={`${styles.input} ${pwErr ? styles.err : ""}`}
              type={show ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              spellCheck={false}
              placeholder="••••••••"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
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
      </form>

      <div className={styles.foot}>
        <button
          type="button"
          className={styles.workerSwitch}
          onClick={() => {
            setMode("worker");
            setError(null);
          }}
          data-testid="login-worker-switch"
        >
          On the tools? Sign in with your email &amp; PIN →
        </button>
      </div>
    </div>
  );
}

/**
 * #421 — worker sign-in, email-first (2026-07-28): email + 4-digit PIN on big
 * keys. No "Work email" / "Password" anywhere. Same POST as the office form
 * (typed value → username, PIN → secret); the server also accepts a legacy
 * NAME username unchanged. A wrong PIN clears the keys for an immediate retry.
 */
function WorkerSignIn({
  pending,
  error,
  onBack,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (name: string, pin: string, clearPin: () => void) => void;
}) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");

  const tapKey = (d: string) => setPin((p) => (p.length >= 4 ? p : p + d));
  const backspace = () => setPin((p) => p.slice(0, -1));
  const ready = name.trim().length > 0 && pin.length === 4 && !pending;

  function submit() {
    if (name.trim().length === 0 || pin.length !== 4 || pending) return;
    onSubmit(name.trim(), pin, () => setPin(""));
  }

  return (
    <div className={styles.card}>
      <div className={styles.topmark}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.topmarkLogo} src="/brand/buhl-logo-ink.png" alt="bühl electrical" />
      </div>

      <h2 className={styles.h}>Let&apos;s get you in.</h2>
      <div className={styles.accentBar} aria-hidden="true" />

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        {error ? (
          <div className={styles.banner} role="alert" data-testid="worker-error">
            <div className={styles.ic}>!</div>
            <div>
              <b>That PIN doesn&apos;t match</b>
              <p>Try again — your email and 4-digit PIN.</p>
            </div>
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="worker-name">
            <span>Your email</span>
          </label>
          <div className={styles.inputWrap}>
            <input
              id="worker-name"
              data-testid="worker-name"
              className={styles.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="e.g. jdoust@gmail.com"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="worker-pin">
            <span>PIN</span>
          </label>
          {/* A native numeric field (inputMode=numeric) for accessibility +
              the device keypad; the big on-screen keys below are the glove-
              friendly primary input. Both write the same 4-digit PIN. */}
          <input
            id="worker-pin"
            data-testid="worker-pin"
            className={styles.pinField}
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={4}
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
          <div className={styles.keypad}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                type="button"
                className={styles.padKey}
                onClick={() => tapKey(d)}
                data-testid={`worker-key-${d}`}
              >
                {d}
              </button>
            ))}
            <button type="button" className={styles.padKeyMuted} onClick={onBack}>
              Office
            </button>
            <button
              type="button"
              className={styles.padKey}
              onClick={() => tapKey("0")}
              data-testid="worker-key-0"
            >
              0
            </button>
            <button
              type="button"
              className={styles.padKeyMuted}
              onClick={backspace}
              aria-label="Delete"
            >
              ⌫
            </button>
          </div>
        </div>

        <button
          type="submit"
          data-testid="worker-submit"
          className={`${styles.submit} ${pending ? styles.busy : ""}`}
          disabled={!ready}
        >
          {pending ? (
            <>
              <span className={styles.spinner} />Signing in…
            </>
          ) : (
            <>Sign in →</>
          )}
        </button>
      </form>

      <div className={styles.foot}>
        <button type="button" className={styles.workerSwitch} onClick={onBack}>
          ← Office sign-in (email &amp; password)
        </button>
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
