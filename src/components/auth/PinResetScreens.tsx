"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import {
  acceptPinReset,
  pinResetErrorText,
  requestPinReset,
  type PinResetOutcome,
  type PinResetState,
} from "@/domains/auth/pin-reset";

/**
 * Self-service PIN / password recovery screens (owner pull 2026-09-14 — a
 * worker who has logged out and forgotten their PIN gets themselves back in).
 *
 * Mobile-first and glove-sized, matching the invite landing's idiom: one
 * question per screen, one primary action, calm copy, site language (P11).
 *
 * HONESTY (P7): every outcome gets its own screen, including "there's no
 * account with that email" (owner decision 2026-09-15 — the neutral
 * same-answer-every-time version left a worker who mistyped waiting on a link
 * that was never sent). A wrong address is a typo you can fix on the spot; an
 * account we can't email is a phone call. Never show "check your email" for
 * anything but a real send. When email isn't wired at all the form is not
 * offered; the office phone is shown instead of a button that could never
 * deliver.
 */

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface px-5 pb-8 pt-6">
      {children}
    </main>
  );
}

function PrimaryCta({
  children,
  disabled,
  busy,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "mt-auto flex h-14 w-full items-center justify-center gap-2 rounded-card text-base font-semibold transition-colors",
        disabled || busy
          ? "cursor-not-allowed bg-border text-text-muted"
          : "bg-accent-yellow text-brand-navy active:opacity-90"
      )}
    >
      {busy ? "One sec…" : children}
    </button>
  );
}

function SignInLink({ label = "Back to sign in" }: { label?: string }) {
  return (
    <a
      href="/v2/login"
      data-testid="pin-reset-signin"
      className="mt-4 flex h-14 w-full items-center justify-center rounded-card border border-brand-navy text-base font-semibold text-brand-navy"
    >
      {label}
    </a>
  );
}

/* ---------------------------------------------------------------- request -- */

export function PinResetRequestScreen({
  emailConfigured,
  officePhone,
  defaultOutcome = null,
}: {
  /** False → we cannot deliver a link, so we never offer the form (P7). */
  emailConfigured: boolean;
  officePhone: string;
  /** Start on one of the outcome screens (render tests only — the real one
   *  arrives from the server, and renderToString runs no effects). */
  defaultOutcome?: PinResetOutcome | null;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PinResetOutcome | null>(defaultOutcome);
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!emailConfigured) {
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text">Give the office a call</h1>
          <p className="mt-2 text-sm text-text-muted">
            Resetting your PIN by email isn&rsquo;t switched on yet. Ring the office on{" "}
            <b className="text-text">{officePhone}</b> and they&rsquo;ll set you a new one on the
            spot.
          </p>
        </div>
        <SignInLink />
      </Screen>
    );
  }

  if (outcome === "sent") {
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text" data-testid="pin-reset-sent">
            Check your email
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            A link is on its way to <b className="text-text">{email.trim()}</b>. Open it on this
            phone and pick a new PIN — it only works for the next hour.
          </p>
          <p className="mt-3 text-sm text-text-muted">
            Nothing after a few minutes? Check your junk folder, or ring the office on{" "}
            <b className="text-text">{officePhone}</b>.
          </p>
        </div>
        <SignInLink />
      </Screen>
    );
  }

  if (outcome === "no_account") {
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text" data-testid="pin-reset-no-account">
            No account with that email
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            Nothing here is signed up as <b className="text-text">{email.trim()}</b>. It&rsquo;s
            usually the other one — if you tried your bühl address, try your personal one, or the
            other way round.
          </p>
          <p className="mt-3 text-sm text-text-muted">
            Still stuck? Ring the office on <b className="text-text">{officePhone}</b> and
            they&rsquo;ll set you a new PIN on the spot.
          </p>
        </div>
        <PrimaryCta onClick={tryAnother} testId="pin-reset-try-another">
          Try another email
        </PrimaryCta>
        <SignInLink />
      </Screen>
    );
  }

  if (outcome === "unavailable") {
    // There IS an account — it just can't be emailed (no address on file, or
    // switched off). Which of those it is, is the office's news to break.
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text" data-testid="pin-reset-unavailable">
            Give the office a call
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            We can&rsquo;t send a reset link for that account. Ring the office on{" "}
            <b className="text-text">{officePhone}</b> — they can set you a new PIN on the spot.
          </p>
        </div>
        <SignInLink />
      </Screen>
    );
  }

  if (outcome === "throttled") {
    const mins = Math.max(1, Math.ceil((retryAfterSec ?? 0) / 60));
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text" data-testid="pin-reset-throttled">
            Too many tries
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            Give it about {mins} {mins === 1 ? "minute" : "minutes"} and try again — or ring the
            office on <b className="text-text">{officePhone}</b> if you need in now.
          </p>
        </div>
        <SignInLink />
      </Screen>
    );
  }

  function tryAnother() {
    setOutcome(null);
    setRetryAfterSec(null);
    setError(null);
  }

  async function send() {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const res = await requestPinReset(trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(pinResetErrorText(res.error));
      return;
    }
    // An older deploy answers without an outcome; that reply only ever came
    // back after a send was attempted, so read it as 'sent'.
    setRetryAfterSec(res.data.retryAfterSec ?? null);
    setOutcome(res.data.outcome ?? "sent");
  }

  return (
    <Screen>
      <h1 className="font-display text-xl text-text">Forgotten your PIN?</h1>
      <p className="mt-2 text-sm text-text-muted">
        Put in the email you sign in with and we&rsquo;ll send you a link to set a new one.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}

      <label className="mt-5 block">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
          Your email
        </span>
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          data-testid="pin-reset-email"
          className="mt-1 h-14 w-full rounded-card border border-border bg-surface-raised px-4 text-base text-text outline-none focus:border-brand-navy"
        />
      </label>
      <p className="mt-2 text-sm text-text-muted">
        It&rsquo;s the email on your account — often your personal one, not your bühl address.
      </p>

      <PrimaryCta
        onClick={() => void send()}
        disabled={!email.trim()}
        busy={busy}
        testId="pin-reset-send"
      >
        Send me a link
      </PrimaryCta>
      <SignInLink />
    </Screen>
  );
}

/* ----------------------------------------------------------------- accept -- */

export function PinResetLanding({
  token,
  state,
  firstName,
  isPassword = false,
  officePhone,
}: {
  token: string;
  state: PinResetState;
  firstName?: string | null;
  isPassword?: boolean;
  officePhone: string;
}) {
  const noun = isPassword ? "password" : "PIN";
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (state !== "valid") {
    const copy: Record<string, { title: string; body: string }> = {
      expired: {
        title: "That link has expired",
        body: "They only last an hour. Ask for a fresh one and open it straight away.",
      },
      used: {
        title: "That link has already been used",
        body: "If that was you, sign in with your new PIN. If it wasn't, ring the office now.",
      },
      invalid: {
        title: "That link doesn't look right",
        body: "Try the newest email, or ask for a fresh link.",
      },
    };
    const c = copy[state] ?? copy.invalid!;
    return (
      <Screen>
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <h1 className="font-display text-xl text-text" data-testid="pin-reset-dead-end">
            {c.title}
          </h1>
          <p className="mt-2 text-sm text-text-muted">{c.body}</p>
          <p className="mt-3 text-sm text-text-muted">
            Stuck? Ring the office on <b className="text-text">{officePhone}</b>.
          </p>
        </div>
        <Link
          href="/reset"
          className="mt-auto flex h-14 w-full items-center justify-center rounded-card bg-accent-yellow text-base font-semibold text-brand-navy"
        >
          Send me a new link
        </Link>
        <SignInLink />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen>
        <div className="rounded-card border border-emerald-200 bg-emerald-50 p-5">
          <h1 className="font-display text-xl text-emerald-900" data-testid="pin-reset-done">
            Your new {noun} is set
          </h1>
          <p className="mt-2 text-sm text-emerald-900/80">
            Sign in with your email and the {noun} you just picked.
          </p>
        </div>
        <a
          href="/v2/login?mode=worker"
          data-testid="pin-reset-go-signin"
          className="mt-auto flex h-14 w-full items-center justify-center rounded-card bg-accent-yellow text-base font-semibold text-brand-navy"
        >
          Sign in
        </a>
      </Screen>
    );
  }

  const formatOk = isPassword ? pin.length >= 6 : /^\d{4}$/.test(pin);
  const canSave = formatOk && pin === confirm && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const res = await acceptPinReset({ token, pin, confirmPin: confirm });
    setBusy(false);
    if (!res.ok) {
      setError(pinResetErrorText(res.error));
      return;
    }
    // Clear the typed value the moment the server confirms — it never lingers.
    setPin("");
    setConfirm("");
    setDone(true);
  }

  const onChange = (v: string) =>
    isPassword ? v : v.replace(/\D/g, "").slice(0, 4);

  return (
    <Screen>
      <h1 className="font-display text-xl text-text">
        {firstName ? `G'day ${firstName}.` : "Let's get you back in."}
      </h1>
      <p className="mt-2 text-sm text-text-muted">
        Pick a new {noun}. You&rsquo;ll use it with your email to sign in.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}

      <label className="mt-5 block">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
          New {noun} {isPassword ? "(6+ characters)" : "(4 digits)"}
        </span>
        <input
          type={isPassword ? "password" : "text"}
          inputMode={isPassword ? undefined : "numeric"}
          pattern={isPassword ? undefined : "[0-9]*"}
          autoComplete="new-password"
          maxLength={isPassword ? 72 : 4}
          value={pin}
          onChange={(e) => setPin(onChange(e.target.value))}
          disabled={busy}
          data-testid="pin-reset-new"
          className="mt-1 h-14 w-full rounded-card border border-border bg-surface-raised px-4 font-mono text-lg tracking-[0.3em] text-text outline-none focus:border-brand-navy"
        />
      </label>

      <label className="mt-4 block">
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
          Same again
        </span>
        <input
          type={isPassword ? "password" : "text"}
          inputMode={isPassword ? undefined : "numeric"}
          pattern={isPassword ? undefined : "[0-9]*"}
          autoComplete="new-password"
          maxLength={isPassword ? 72 : 4}
          value={confirm}
          onChange={(e) => setConfirm(onChange(e.target.value))}
          disabled={busy}
          data-testid="pin-reset-confirm"
          className="mt-1 h-14 w-full rounded-card border border-border bg-surface-raised px-4 font-mono text-lg tracking-[0.3em] text-text outline-none focus:border-brand-navy"
        />
      </label>

      {pin && confirm && pin !== confirm ? (
        <p className="mt-2 text-sm text-rose-700">Those don&rsquo;t match.</p>
      ) : null}
      {!isPassword ? (
        <p className="mt-2 text-sm text-text-muted">
          Not 1234 or your birthday — something only you&rsquo;d pick.
        </p>
      ) : null}

      <PrimaryCta onClick={() => void save()} disabled={!canSave} busy={busy} testId="pin-reset-save">
        Save my {noun}
      </PrimaryCta>
    </Screen>
  );
}
