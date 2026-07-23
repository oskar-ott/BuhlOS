"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Pause, Play, XCircle } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  SignupAdminResponseSchema,
  SIGNUP_ROLE_LABELS,
  type SignupLinkView,
  type SignupRequestPublic,
} from "@/domains/employees/signup";

/**
 * Crew sign-up link panel (/employees, behind the `signup_link` flag): the
 * shareable /onboarding/<code> link + the pending review queue. A signup is
 * NOT an account until approved here — this queue IS the security gate for
 * the deliberately shareable link.
 */
export function CrewSignupPanel() {
  const [link, setLink] = useState<SignupLinkView | null>(null);
  const [requests, setRequests] = useState<SignupRequestPublic[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // House rule: no window.confirm — destructive link actions arm on first
  // click ("Sure?") and fire on the second (see DefectsRegister).
  const [armed, setArmed] = useState<"revoke" | "newlink" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/employees?action=signup", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = SignupAdminResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("bad response");
      setLink(parsed.data.link);
      setRequests(parsed.data.requests);
      setError(null);
    } catch {
      setError("Couldn't load the sign-up link. Refresh to try again.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(action: string, body?: Record<string, unknown>, id?: string) {
    setBusy(id ?? action);
    try {
      const qs = id ? `&id=${encodeURIComponent(id)}` : "";
      const res = await fetch(`/api/employees?action=${action}${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work. Try again.");
        return false;
      }
      setError(null);
      await load();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — long-press the link text instead.");
    }
  }

  if (!loaded) {
    return (
      <Card aria-busy="true">
        <CardTitle>Crew sign-up link</CardTitle>
        <CardDescription>Loading…</CardDescription>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Crew sign-up link</CardTitle>
            <CardDescription className="mt-1 max-w-xl">
              One link for the group chat. Anyone who opens it signs themselves up — nothing goes
              live until you approve them below.
            </CardDescription>
          </div>
          {link ? <LinkStateChip state={link.state} /> : null}
        </div>

        {error ? (
          <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
            {error}
          </p>
        ) : null}

        {link ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-card border border-border bg-surface-subtle px-3 py-2.5 font-mono text-[13px] text-text"
                data-testid="signup-link-url"
              >
                {link.url}
              </code>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex h-10 items-center gap-1.5 rounded-card bg-brand-navy px-3 text-sm font-semibold text-white"
              >
                <Copy className="h-4 w-4" aria-hidden /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[13px] text-text-muted">
              {link.state === "valid"
                ? `Open until ${formatDate(link.expiresAt)}${link.cap ? ` · capped at ${link.cap}` : ""}. `
                : ""}
              {link.counts.pending} pending · {link.counts.approved} approved
              {link.counts.rejected ? ` · ${link.counts.rejected} rejected` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {link.status === "active" ? (
                <PanelButton
                  onClick={() => void post("signup-link-update", { status: "paused" })}
                  busy={busy === "signup-link-update"}
                >
                  <Pause className="h-4 w-4" aria-hidden /> Pause
                </PanelButton>
              ) : (
                <PanelButton
                  onClick={() => void post("signup-link-update", { status: "active" })}
                  busy={busy === "signup-link-update"}
                >
                  <Play className="h-4 w-4" aria-hidden /> Resume
                </PanelButton>
              )}
              <PanelButton
                onClick={() => {
                  if (armed === "revoke") {
                    setArmed(null);
                    void post("signup-link-update", { status: "revoked" });
                  } else {
                    setArmed("revoke");
                  }
                }}
                busy={busy === "signup-link-update"}
              >
                <XCircle className="h-4 w-4" aria-hidden />
                {armed === "revoke" ? "Sure? Revoke — no one can use it" : "Revoke"}
              </PanelButton>
              <PanelButton
                onClick={() => {
                  if (armed === "newlink") {
                    setArmed(null);
                    void post("signup-link", {});
                  } else {
                    setArmed("newlink");
                  }
                }}
                busy={busy === "signup-link"}
              >
                <Link2 className="h-4 w-4" aria-hidden />
                {armed === "newlink" ? "Sure? Old link stops working" : "New link"}
              </PanelButton>
              {armed ? <PanelButton onClick={() => setArmed(null)}>Cancel</PanelButton> : null}
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void post("signup-link", {})}
              disabled={busy === "signup-link"}
              className="inline-flex h-11 items-center gap-2 rounded-card bg-accent-yellow px-4 text-sm font-bold text-brand-navy disabled:opacity-60"
              data-testid="signup-link-generate"
            >
              <Link2 className="h-4 w-4" aria-hidden />
              {busy === "signup-link" ? "Creating…" : "Generate link (lasts 7 days)"}
            </button>
          </div>
        )}
      </Card>

      {requests.length > 0 ? (
        <Card>
          <CardTitle>Waiting on you ({requests.length})</CardTitle>
          <CardDescription className="mt-1">
            Approve creates their account and sends the welcome email. The legal name + date of
            birth are there so matching them in Xero payroll is a one-glance job.
          </CardDescription>
          <ul className="mt-4 space-y-3">
            {requests.map((r) => (
              <RequestCard
                key={r.id}
                request={r}
                busy={busy === r.id}
                onApprove={() => void post("signup-approve", {}, r.id)}
                onReject={(reason) => void post("signup-reject", { reason }, r.id)}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function LinkStateChip({ state }: { state: SignupLinkView["state"] }) {
  const styles: Record<string, string> = {
    valid: "bg-emerald-50 text-emerald-700 border-emerald-200",
    paused: "bg-amber-50 text-amber-800 border-amber-200",
    expired: "bg-amber-50 text-amber-800 border-amber-200",
    capped: "bg-amber-50 text-amber-800 border-amber-200",
    revoked: "bg-surface-subtle text-text-muted border-border",
    invalid: "bg-surface-subtle text-text-muted border-border",
  };
  const label: Record<string, string> = {
    valid: "Live",
    paused: "Paused",
    expired: "Expired",
    capped: "At cap",
    revoked: "Revoked",
    invalid: "—",
  };
  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-[12px] font-semibold", styles[state])}>
      {label[state]}
    </span>
  );
}

function PanelButton({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-9 items-center gap-1.5 rounded-card border border-border bg-white px-3 text-[13px] font-semibold text-text disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function RequestCard({
  request: r,
  busy,
  onApprove,
  onReject,
}: {
  request: SignupRequestPublic;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  // House rule: no window.prompt — the knock-back reason is an inline field.
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Label via the role map — never compare role strings (tier-bug lint rule).
  const roleLabel =
    SIGNUP_ROLE_LABELS[r.role] + (r.apprenticeYear != null ? ` · year ${r.apprenticeYear}` : "");
  return (
    <li className="rounded-card border border-border bg-white p-4" data-testid="signup-request-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-display text-base font-semibold text-text">
            {r.firstName} {r.lastName}
            {r.preferredName ? <span className="text-text-muted"> ({r.preferredName})</span> : null}
          </p>
          <p className="mt-0.5 text-sm text-text-muted">
            {roleLabel} · {r.mobile} · {r.email}
          </p>
        </div>
        <p className="text-[12px] text-text-muted">{formatDate(r.submittedAt)}</p>
      </div>

      <div className="mt-3 rounded-card bg-surface-subtle px-3 py-2 text-[13px] text-text">
        <span className="font-mono text-[12px] uppercase tracking-widest text-text-muted">
          Xero match ·{" "}
        </span>
        {r.legalName} · born {r.dob}
        {r.startDate ? ` · starts ${r.startDate}` : ""}
      </div>

      {r.flags.duplicateEmail || r.flags.duplicateName ? (
        <p className="mt-2 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {r.flags.duplicateEmail
            ? "This email already exists in the register — check before approving."
            : "Same name as an existing employee — check it's not a double-up."}
        </p>
      ) : null}

      {rejecting ? (
        <div className="mt-3 space-y-2">
          <input
            className="h-10 w-full rounded-card border border-border bg-white px-3 text-sm text-text outline-none focus:border-brand-navy"
            placeholder="Why knock this one back? (kept in the audit trail)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onReject(reason)}
              disabled={busy}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-card border border-amber-300 bg-amber-50 text-sm font-bold text-amber-900 disabled:opacity-60"
              data-testid="signup-reject-confirm"
            >
              {busy ? "Working…" : "Confirm knock-back"}
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center rounded-card border border-border bg-white px-4 text-sm font-semibold text-text disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-card bg-accent-yellow text-sm font-bold text-brand-navy disabled:opacity-60"
            data-testid="signup-approve"
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="inline-flex h-10 items-center justify-center rounded-card border border-border bg-white px-4 text-sm font-semibold text-text disabled:opacity-60"
            data-testid="signup-reject"
          >
            Knock back
          </button>
        </div>
      )}
    </li>
  );
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
