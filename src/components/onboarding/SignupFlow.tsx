"use client";

import { useState } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { validatePin, pinsMatch, isValidAuMobile } from "@/domains/employees/service";
import {
  SIGNUP_ROLES,
  SIGNUP_ROLE_LABELS,
  isPlausibleDob,
  type SignupLinkState,
  type SignupResolveResponse,
  type SignupRole,
} from "@/domains/employees/signup";

interface SignupFlowProps {
  code: string;
  state: SignupLinkState;
  link: SignupResolveResponse["link"];
}

/**
 * Crew sign-up self-service flow (mobile-first): landing → who you are →
 * payroll match → PIN → review → pending. Mirrors the invite setup flow's
 * shell (one primary CTA per screen, calm copy, honest dead states). The
 * submission only creates a pending request — copy says so plainly.
 */
export function SignupFlow({ code, state, link }: SignupFlowProps) {
  if (state !== "valid" || !link) return <DeadState state={state} />;
  return <Steps code={code} companyName={link.companyName} createdByName={link.createdByName ?? null} />;
}

/* ---- shell ---- */

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-surface px-5 pb-8 pt-6">
      {children}
    </main>
  );
}

const TOTAL_STEPS = 4;

function Progress({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <div className="mb-5 flex gap-1.5" aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
      {[1, 2, 3, 4].map((n) => (
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
          : "bg-accent-yellow text-brand-navy active:opacity-90",
      )}
    >
      {busy ? "One sec…" : children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[12px] font-semibold uppercase tracking-widest text-text-muted">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[12px] text-text-muted">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "h-12 w-full rounded-card border border-border bg-white px-3 text-base text-text outline-none focus:border-brand-navy";

/* ---- dead states ---- */

function DeadState({ state }: { state: SignupLinkState }) {
  const FALLBACK = {
    title: "This link isn't valid",
    body: "Check you tapped the full link from the group chat. If it still doesn't work, ask the office.",
  };
  const copy: Record<string, { title: string; body: string }> = {
    expired: {
      title: "This link has expired",
      body: "Sign-up links only last a little while. Ask the office to post a fresh one in the group chat.",
    },
    paused: {
      title: "Sign-ups are paused",
      body: "The office has paused this link for now. Check with them and try again later.",
    },
    capped: {
      title: "This link has hit its limit",
      body: "The office capped how many people can sign up on this link. Ask them to open it up again.",
    },
    revoked: {
      title: "This link is no longer active",
      body: "It may have been replaced. Ask the office for the current link.",
    },
    invalid: {
      title: "This link isn't valid",
      body: "Check you tapped the full link from the group chat. If it still doesn't work, ask the office.",
    },
  };
  const c = copy[state] ?? FALLBACK;
  return (
    <Screen>
      <div className="my-auto text-center">
        <h1 className="font-display text-xl text-text">{c.title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-text-muted">{c.body}</p>
        <a
          href="/v2/login"
          className="mt-6 inline-flex items-center gap-1 text-[15px] font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          Already set up? Sign in
        </a>
      </div>
    </Screen>
  );
}

/* ---- the steps ---- */

type Step = "landing" | "about" | "payroll" | "pin" | "review" | "done";

interface Draft {
  firstName: string;
  lastName: string;
  preferredName: string;
  mobile: string;
  email: string;
  // "crewRole", not "role": this is the requested trade, not a session tier, and
  // the repo-wide lint bans comparing a `.role` property to literals (tier-bug guard).
  crewRole: SignupRole | null;
  apprenticeYear: number | null;
  legalName: string;
  dob: string;
  startDate: string;
  pin: string;
  confirmPin: string;
}

const EMPTY: Draft = {
  firstName: "",
  lastName: "",
  preferredName: "",
  mobile: "",
  email: "",
  crewRole: null,
  apprenticeYear: null,
  legalName: "",
  dob: "",
  startDate: "",
  pin: "",
  confirmPin: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Steps({
  code,
  companyName,
  createdByName,
}: {
  code: string;
  companyName: string;
  createdByName: string | null;
}) {
  const [step, setStep] = useState<Step>("landing");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const aboutOk =
    draft.firstName.trim().length > 0 &&
    draft.lastName.trim().length > 0 &&
    isValidAuMobile(draft.mobile) &&
    EMAIL_RE.test(draft.email.trim()) &&
    draft.crewRole !== null &&
    (draft.crewRole !== "apprentice" ||
      (draft.apprenticeYear !== null && draft.apprenticeYear >= 1 && draft.apprenticeYear <= 4));

  const payrollOk = draft.legalName.trim().length > 0 && isPlausibleDob(draft.dob, Date.now());

  const pinCheck = validatePin(draft.pin);
  const pinOk = pinCheck.ok && pinsMatch(draft.pin, draft.confirmPin);

  async function submit() {
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch("/api/signup?action=submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          preferredName: draft.preferredName.trim() || null,
          mobile: draft.mobile.trim(),
          email: draft.email.trim(),
          role: draft.crewRole,
          apprenticeYear: draft.apprenticeYear,
          legalName: draft.legalName.trim(),
          dob: draft.dob,
          startDate: draft.startDate || null,
          pin: draft.pin,
          confirmPin: draft.confirmPin,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setServerError(data.error ?? "Couldn't send that. Give it another go.");
        return;
      }
      setStep("done");
    } catch {
      setServerError("No connection. Find some signal and hit send again — nothing was lost.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "landing") {
    return (
      <Screen>
        <div className="my-auto">
          <p className="font-mono text-[12px] uppercase tracking-widest text-text-muted">
            {companyName}
          </p>
          <h1 className="mt-2 font-display text-2xl leading-tight text-text">
            You&rsquo;ve been invited to join {companyName} on BuhlOS.
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-text-muted">
            {createdByName ? `${createdByName} shared this link. ` : ""}BuhlOS is the app the crew
            uses for hours, jobs and gear. Sign yourself up — takes about two minutes — and the
            office approves you.
          </p>
          <ul className="mt-5 space-y-2 text-[15px] text-text">
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand-navy" aria-hidden /> Your details, your
              PIN
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand-navy" aria-hidden /> The office checks
              it&rsquo;s really you
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand-navy" aria-hidden /> You get an email when
              you&rsquo;re in
            </li>
          </ul>
        </div>
        <PrimaryCta onClick={() => setStep("about")}>
          Start <ArrowRight className="h-5 w-5" aria-hidden />
        </PrimaryCta>
      </Screen>
    );
  }

  if (step === "about") {
    return (
      <Screen>
        <Progress step={1} />
        <h1 className="font-display text-xl text-text">Who are you?</h1>
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <input
                className={inputCls}
                value={draft.firstName}
                onChange={(e) => set({ firstName: e.target.value })}
                autoComplete="given-name"
              />
            </Field>
            <Field label="Last name">
              <input
                className={inputCls}
                value={draft.lastName}
                onChange={(e) => set({ lastName: e.target.value })}
                autoComplete="family-name"
              />
            </Field>
          </div>
          <Field label="What you go by" hint="Optional — if it's different.">
            <input
              className={inputCls}
              value={draft.preferredName}
              onChange={(e) => set({ preferredName: e.target.value })}
            />
          </Field>
          <Field label="Mobile">
            <input
              className={inputCls}
              inputMode="tel"
              placeholder="04…"
              value={draft.mobile}
              onChange={(e) => set({ mobile: e.target.value })}
              autoComplete="tel"
            />
          </Field>
          <Field label="Email" hint="Your welcome email lands here once you're approved.">
            <input
              className={inputCls}
              inputMode="email"
              value={draft.email}
              onChange={(e) => set({ email: e.target.value })}
              autoComplete="email"
            />
          </Field>
          <Field label="Your role">
            <div className="grid grid-cols-2 gap-2">
              {SIGNUP_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => set({ crewRole: r, apprenticeYear: r === "apprentice" ? draft.apprenticeYear : null })}
                  className={cn(
                    "h-12 rounded-card border text-[15px] font-semibold",
                    draft.crewRole === r
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "border-border bg-white text-text",
                  )}
                >
                  {SIGNUP_ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </Field>
          {draft.crewRole === "apprentice" ? (
            <Field label="Apprentice year">
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((y) => (
                  <button
                    key={y}
                    type="button"
                    onClick={() => set({ apprenticeYear: y })}
                    className={cn(
                      "h-12 rounded-card border text-[15px] font-semibold",
                      draft.apprenticeYear === y
                        ? "border-brand-navy bg-brand-navy text-white"
                        : "border-border bg-white text-text",
                    )}
                  >
                    {y}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}
        </div>
        <div className="mt-6" />
        <PrimaryCta disabled={!aboutOk} onClick={() => setStep("payroll")}>
          Next <ArrowRight className="h-5 w-5" aria-hidden />
        </PrimaryCta>
      </Screen>
    );
  }

  if (step === "payroll") {
    return (
      <Screen>
        <Progress step={2} />
        <h1 className="font-display text-xl text-text">Payroll match</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-text-muted">
          The office uses this to match you to payroll — nothing else. Only the office sees it. No
          tax file number, no bank details — payroll already holds those.
        </p>
        <div className="mt-4 space-y-4">
          <Field label="Full legal name" hint="Exactly as it shows on your payslip.">
            <input
              className={inputCls}
              value={draft.legalName}
              onChange={(e) => set({ legalName: e.target.value })}
              autoComplete="name"
            />
          </Field>
          <Field label="Date of birth">
            <input
              className={inputCls}
              type="date"
              value={draft.dob}
              onChange={(e) => set({ dob: e.target.value })}
              autoComplete="bday"
            />
          </Field>
          <Field label="Start date" hint="If you know it — otherwise leave it.">
            <input
              className={inputCls}
              type="date"
              value={draft.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-6" />
        <PrimaryCta disabled={!payrollOk} onClick={() => setStep("pin")}>
          Next <ArrowRight className="h-5 w-5" aria-hidden />
        </PrimaryCta>
      </Screen>
    );
  }

  if (step === "pin") {
    return (
      <Screen>
        <Progress step={3} />
        <h1 className="font-display text-xl text-text">Pick your PIN</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-text-muted">
          4 digits. You&rsquo;ll use it with your name every time you open BuhlOS. Pick something
          you&rsquo;ll remember — but not 1234.
        </p>
        <div className="mt-4 space-y-4">
          <Field label="PIN">
            <input
              className={cn(inputCls, "text-center font-mono text-xl tracking-[0.5em]")}
              inputMode="numeric"
              type="password"
              maxLength={4}
              value={draft.pin}
              onChange={(e) => set({ pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
          </Field>
          <Field label="Same PIN again">
            <input
              className={cn(inputCls, "text-center font-mono text-xl tracking-[0.5em]")}
              inputMode="numeric"
              type="password"
              maxLength={4}
              value={draft.confirmPin}
              onChange={(e) => set({ confirmPin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
          </Field>
          {draft.pin.length === 4 && !pinCheck.ok ? (
            <p className="text-[13px] text-state-danger">{pinCheck.reason}</p>
          ) : null}
          {draft.pin.length === 4 && draft.confirmPin.length === 4 && pinCheck.ok && !pinsMatch(draft.pin, draft.confirmPin) ? (
            <p className="text-[13px] text-state-danger">Those PINs don&rsquo;t match.</p>
          ) : null}
        </div>
        <div className="mt-6" />
        <PrimaryCta disabled={!pinOk} onClick={() => setStep("review")}>
          Next <ArrowRight className="h-5 w-5" aria-hidden />
        </PrimaryCta>
      </Screen>
    );
  }

  if (step === "review") {
    const rows: Array<[string, string]> = [
      ["Name", `${draft.firstName} ${draft.lastName}${draft.preferredName ? ` (${draft.preferredName})` : ""}`],
      ["Mobile", draft.mobile],
      ["Email", draft.email],
      ["Role", draft.crewRole ? SIGNUP_ROLE_LABELS[draft.crewRole] + (draft.crewRole === "apprentice" ? ` · year ${draft.apprenticeYear}` : "") : ""],
      ["Legal name", draft.legalName],
      ["Date of birth", draft.dob],
      ["Start date", draft.startDate || "—"],
    ];
    return (
      <Screen>
        <Progress step={4} />
        <h1 className="font-display text-xl text-text">Check it, then send.</h1>
        <dl className="mt-4 divide-y divide-border rounded-card border border-border bg-white">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
              <dt className="shrink-0 font-mono text-[12px] uppercase tracking-widest text-text-muted">{k}</dt>
              <dd className="text-right text-[15px] text-text">{v}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          onClick={() => setStep("about")}
          className="mt-3 self-start text-[14px] font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          Change something
        </button>
        <p className="mt-4 text-[14px] leading-relaxed text-text-muted">
          The office checks it&rsquo;s really you, then you&rsquo;re in. You&rsquo;ll get an email
          and can sign in once approved.
        </p>
        {serverError ? (
          <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] text-amber-900" role="alert">
            {serverError}
          </p>
        ) : null}
        <div className="mt-6" />
        <PrimaryCta busy={busy} onClick={submit}>
          Send to the office <ArrowRight className="h-5 w-5" aria-hidden />
        </PrimaryCta>
      </Screen>
    );
  }

  // done
  return (
    <Screen>
      <div className="my-auto text-center">
        <p className="font-mono text-[12px] uppercase tracking-widest text-text-muted">Sent</p>
        <h1 className="mt-2 font-display text-2xl text-text">Nice one, {draft.preferredName || draft.firstName}.</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-text-muted">
          The office has your sign-up. Once they approve it you&rsquo;ll get a welcome email at{" "}
          <span className="font-semibold text-text">{draft.email}</span> — then sign in with your
          name and PIN.
        </p>
        <p className="mt-4 text-[14px] text-text-muted">
          Nothing else to do here. See you on site.
        </p>
      </div>
    </Screen>
  );
}
