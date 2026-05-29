"use client";

import { useState } from "react";
import { ArrowRight, Clock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { acceptInvite, acceptErrorText } from "@/domains/employees/invite-client";
import { validatePin, pinsMatch, isValidAuMobile } from "@/domains/employees/service";
import { formatShortDate } from "@/domains/employees/format";
import type { InviteResolveState, ResolvedInvite } from "@/domains/employees/types";

interface PhilInviteLandingProps {
  token: string;
  state: InviteResolveState;
  invite: ResolvedInvite | null;
}

/**
 * Worker invite landing + setup flow (bible §06: P1 landing → P4 confirm →
 * P5 PIN → P6 intro). Mobile-first, one primary CTA per screen, calm copy.
 * The token is resolved server-side (no flicker); this component renders the
 * matching state and, for a valid invite, drives the client-side setup that
 * ends in a single `accept` call.
 */
export function PhilInviteLanding({ token, state, invite }: PhilInviteLandingProps) {
  if (state !== "valid" || !invite) {
    return <InviteErrorState state={state} />;
  }
  return <SetupFlow token={token} invite={invite} />;
}

/* ---- shell ---- */

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface px-5 pb-8 pt-6">
      {children}
    </main>
  );
}

function Progress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="mb-5 flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={cn("h-1 flex-1 rounded-full", n <= step ? "bg-accent-yellow" : "bg-border")}
        />
      ))}
    </div>
  );
}

function PrimaryCta({
  children,
  disabled,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
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

/* ---- error states (P3 / P8 / P9 / P10) ---- */

function InviteErrorState({ state }: { state: InviteResolveState }) {
  const copy: Record<string, { title: string; body: string; signIn: boolean }> = {
    expired: {
      title: "This invite has expired",
      body: "Ask your supervisor to send a new one, then tap the new link.",
      signIn: true,
    },
    revoked: {
      title: "This invite is no longer active",
      body: "It may have been replaced. Check your inbox for a newer email, or ask your supervisor.",
      signIn: true,
    },
    accepted: {
      title: "This invite has already been used",
      body: "Your account is already set up. Sign in to Phil to get going.",
      signIn: true,
    },
    invalid: {
      title: "This link doesn't look right",
      body: "Try the latest email, or ask your supervisor for a new link.",
      signIn: true,
    },
  };
  const c = copy[state] ?? copy.invalid!;
  return (
    <Screen>
      <div className="rounded-card border border-border bg-surface-subtle p-5">
        <h1 className="font-display text-xl text-text">{c.title}</h1>
        <p className="mt-2 text-sm text-text-muted">{c.body}</p>
      </div>
      {c.signIn ? (
        <a
          href="/v2/login"
          className="mt-auto flex h-14 w-full items-center justify-center rounded-card border border-brand-navy text-base font-semibold text-brand-navy"
        >
          Sign in to Phil
        </a>
      ) : null}
    </Screen>
  );
}

/* ---- valid: the setup flow ---- */

type Step = "landing" | "confirm" | "pin" | "intro";

function SetupFlow({ token, invite }: { token: string; invite: ResolvedInvite }) {
  const [step, setStep] = useState<Step>("landing");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notMe, setNotMe] = useState(false);

  const roleText =
    invite.roleLabel + (invite.role === "apprentice" && invite.apprenticeYear ? ` · Y${invite.apprenticeYear}` : "");
  const phoneOk = !phone || isValidAuMobile(phone);
  const pinResult = validatePin(pin);
  const pinValid = pinResult.ok && pinsMatch(pin, confirm);

  async function open() {
    setBusy(true);
    setError(null);
    const res = await acceptInvite({ token, pin, confirmPin: confirm, phone: phone || null });
    if (!res.ok) {
      setBusy(false);
      setError(acceptErrorText(res.error));
      return;
    }
    // New session cookie is set; hard-navigate so it's applied.
    window.location.assign(res.data.landing);
  }

  if (step === "landing") {
    return (
      <Screen>
        <div className="rounded-card bg-brand-navy p-5 text-text-inverse">
          <p className="font-mono text-[11px] uppercase tracking-widest text-accent-yellow">
            {invite.companyName}
          </p>
          <h1 className="mt-2 font-display text-2xl leading-tight">
            G&rsquo;day {invite.firstName}.
            <br />
            You&rsquo;re invited to Phil.
          </h1>
        </div>
        <div className="mt-3 rounded-card border border-border p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">Role</p>
          <p className="font-display text-lg text-text">{roleText}</p>
        </div>
        <div className="mt-3 rounded-card border border-border p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">Phil is for</p>
          <p className="mt-1 text-sm text-text">
            Logging your hours, checking your gear, and seeing your jobs.
          </p>
        </div>
        <p className="mt-3 inline-flex items-center gap-1.5 self-start rounded-pill border border-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-text-muted">
          <Clock aria-hidden="true" className="h-3 w-3" /> expires {formatShortDate(invite.expiresAt)}
        </p>
        <div className="mt-auto pt-6">
          <PrimaryCta onClick={() => setStep("confirm")}>
            Set up Phil <ArrowRight aria-hidden="true" className="h-5 w-5" />
          </PrimaryCta>
          <button
            type="button"
            onClick={() => setNotMe((v) => !v)}
            className="mt-3 w-full text-center font-mono text-[11px] uppercase tracking-wider text-text-muted"
          >
            This isn&rsquo;t me
          </button>
          {notMe ? (
            <p className="mt-2 text-center text-xs text-text-muted">
              Don&rsquo;t set up — tell your supervisor so they can fix it in BuhlOS.
            </p>
          ) : null}
        </div>
      </Screen>
    );
  }

  if (step === "confirm") {
    return (
      <Screen>
        <Progress step={1} />
        <h1 className="font-display text-xl text-text">Is this you?</h1>
        <div className="mt-4 space-y-2">
          <ReadField label="First name" value={invite.firstName} />
          <ReadField label="Last name" value={invite.lastName} />
          <ReadField label="Email" value={invite.email} />
          {invite.phone ? (
            <ReadField label="Mobile" value={invite.phone} />
          ) : (
            <label className="block rounded-card border border-border p-3">
              <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                Mobile (optional)
              </span>
              <input
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0421 558 902"
                className="mt-1 w-full bg-transparent text-base text-text outline-none"
              />
              {!phoneOk ? (
                <span className="mt-1 block text-xs text-rose-700">Australian mobile, e.g. 0421 558 902</span>
              ) : null}
            </label>
          )}
        </div>
        {invite.jobs.length > 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            On the tools at: <span className="text-text">{invite.jobs.join(", ")}</span>
          </p>
        ) : null}
        <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-wider text-text-muted">
          Wrong? Tell your supervisor before continuing.
        </p>
        <PrimaryCta disabled={!phoneOk} onClick={() => setStep("pin")}>
          Looks right <ArrowRight aria-hidden="true" className="h-5 w-5" />
        </PrimaryCta>
      </Screen>
    );
  }

  if (step === "pin") {
    const showWeak = pin.length === 4 && !pinResult.ok;
    const showMismatch = confirm.length === 4 && !pinsMatch(pin, confirm);
    return (
      <Screen>
        <Progress step={2} />
        <h1 className="font-display text-xl text-text">Pick a 4-digit PIN.</h1>
        <p className="mt-2 text-sm text-text-muted">
          You&rsquo;ll use this every time you open Phil. Pick something you&rsquo;ll remember — but
          not your birthday.
        </p>
        <div className="mt-5 space-y-3">
          <PinInput label="Enter PIN" value={pin} onChange={setPin} />
          <PinInput label="Confirm PIN" value={confirm} onChange={setConfirm} />
        </div>
        {showWeak ? (
          <p className="mt-3 text-sm text-rose-700">{pinResult.ok ? "" : pinResult.reason}</p>
        ) : null}
        {showMismatch ? (
          <p className="mt-3 text-sm text-rose-700">These don&rsquo;t match — try again.</p>
        ) : null}
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-text-muted">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" /> Stored encrypted. We never see it.
        </p>
        <PrimaryCta disabled={!pinValid} onClick={() => setStep("intro")}>
          Set PIN
        </PrimaryCta>
      </Screen>
    );
  }

  // intro
  return (
    <Screen>
      <Progress step={3} />
      <h1 className="font-display text-xl text-text">Phil, in 30 seconds.</h1>
      <div className="mt-4 space-y-2">
        <IntroCard tag="My Day" title="Log your hours." body="Tap once at the end of the day. Boss approves, you get paid." />
        <IntroCard tag="My Gear" title="What you've got." body="See your tools. Flag anything missing or broken." />
        <IntroCard tag="Jobs" title="Where you're working." body="Site info, photos, docs — all in one place." />
      </div>
      {error ? (
        <div className="mt-4 rounded-card border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm text-rose-800">{error}</p>
          <a href="/v2/login" className="mt-1 inline-block text-sm font-semibold text-rose-900 underline">
            Sign in to Phil
          </a>
        </div>
      ) : (
        <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-wider text-text-muted">
          Tip: add Phil to your home screen for one-tap access.
        </p>
      )}
      <PrimaryCta busy={busy} onClick={open}>
        Open Phil <ArrowRight aria-hidden="true" className="h-5 w-5" />
      </PrimaryCta>
    </Screen>
  );
}

/* ---- small building blocks ---- */

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-surface-subtle p-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">{label}</p>
      <p className="mt-0.5 text-base text-text">{value}</p>
    </div>
  );
}

function IntroCard({ tag, title, body }: { tag: string; title: string; body: string }) {
  return (
    <div className="rounded-card border border-border p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">{tag}</p>
      <p className="font-display text-base text-text">{title}</p>
      <p className="mt-0.5 text-sm text-text-muted">{body}</p>
    </div>
  );
}

function PinInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-text-muted">
        {label}
      </span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 4))}
        className="h-14 w-full rounded-card border border-border bg-surface text-center font-mono text-2xl tracking-[0.5em] text-text outline-none focus:border-brand-navy"
        aria-label={label}
      />
    </label>
  );
}
