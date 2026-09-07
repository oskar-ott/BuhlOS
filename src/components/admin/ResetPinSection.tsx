"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { errorText, resetWorkerPin } from "@/domains/employees/client";

/**
 * "Login PIN" inside the employee detail drawer — the office's way to get a
 * locked-out worker back in.
 *
 * Why this exists: a worker who forgets their PIN has no self-service reset,
 * and the invite flow can't help either — accepting an invite REFUSES an email
 * that already has an account (api/invites.js, anti-takeover), so "resend
 * invite" dead-ends for anyone who has ever logged in. The only sanctioned reset
 * is the in-place one the server already supports (PUT /api/users {id, secret},
 * admin-tier): same account id, so assigned jobs and hours history are kept and
 * nothing is duplicated. This section is the button that was left out of the
 * rebuild ("no fake actions") — now a real action on a real endpoint.
 *
 * Credential format mirrors api/users.js validateSecret exactly: a literal
 * 'admin' login takes a password (≥6 chars); every other role takes a 4-digit
 * PIN. Non-optimistic: the "updated" note appears only on a confirmed reply.
 * The new PIN is never shown back or stored client-side — the office typed it
 * and texts it to the worker out-of-band (same discipline as the invite link).
 *
 * Records key on the users.json userId (the id Licences / Cost rate use): a
 * worker who hasn't finished setup has no login to reset yet (honest note).
 */

interface ResetPinSectionProps {
  userId: string | null;
  workerName: string;
  /** The employee's role — a literal 'admin' login uses a password, not a PIN. */
  role: string;
  /** Start with the form open (render tests only). */
  defaultOpen?: boolean;
}

export function ResetPinSection({ userId, workerName, role, defaultOpen = false }: ResetPinSectionProps) {
  // role-literal-ok: credential FORMAT (password vs 4-digit PIN) is tied to the
  // literal stored role in api/users.js validateSecret, not the admin tier.
  const isPassword = role === "admin";
  const noun = isPassword ? "password" : "PIN";

  const [open, setOpen] = useState(defaultOpen);
  const [secret, setSecret] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);

  if (!userId) {
    return (
      <section>
        <SectionHeading noun={noun} />
        <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
          A {noun} can be reset once {workerName} finishes BuhlOS setup — it keys off their
          worker account.
        </p>
      </section>
    );
  }

  const formatOk = isPassword ? secret.length >= 6 : /^\d{4}$/.test(secret);
  const canSave = formatOk && secret === confirm && !busy;

  function openForm() {
    setSecret("");
    setConfirm("");
    setError(null);
    setUpdated(false);
    setOpen(true);
  }

  function cancel() {
    if (busy) return;
    setOpen(false);
    setSecret("");
    setConfirm("");
    setError(null);
  }

  async function save() {
    if (!canSave || !userId) return;
    setBusy(true);
    setError(null);
    const res = await resetWorkerPin({ userId, secret });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.error));
      return;
    }
    // Confirmed by the server — only now say so. Clear the typed value so it
    // never lingers in the drawer.
    setSecret("");
    setConfirm("");
    setOpen(false);
    setUpdated(true);
  }

  return (
    <section>
      <SectionHeading noun={noun} />

      {updated ? (
        <p
          data-testid="reset-pin-updated"
          className="mb-2 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
        >
          {noun === "PIN" ? "PIN" : "Password"} updated for {workerName}. Text it to them — they can
          change it in the app. If they&rsquo;d been locked out from too many wrong tries, that lifts
          within 15 minutes.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </p>
      ) : null}

      {!open ? (
        <div className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface px-3 py-2">
          <p className="text-xs text-text-muted">
            Forgotten {noun}? Set a new one here — same account, nothing else changes.
          </p>
          <Button size="sm" variant="secondary" onClick={openForm} data-testid="reset-pin-open">
            Reset {noun}
          </Button>
        </div>
      ) : (
        <div
          data-testid="reset-pin-form"
          className="space-y-2 rounded-card border border-border bg-surface px-3 py-2"
        >
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              New {noun}{isPassword ? " (6+ characters)" : " (4 digits)"}
            </span>
            <input
              type={isPassword ? "password" : "text"}
              inputMode={isPassword ? undefined : "numeric"}
              pattern={isPassword ? undefined : "[0-9]*"}
              autoComplete="off"
              maxLength={isPassword ? 72 : 4}
              value={secret}
              onChange={(e) =>
                setSecret(isPassword ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              disabled={busy}
              data-testid="reset-pin-input"
              className="mt-0.5 h-10 w-full rounded-card border border-border bg-surface-raised px-3 font-mono text-sm tracking-[0.15em] text-text outline-none focus:border-brand-navy"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Confirm {noun}
            </span>
            <input
              type={isPassword ? "password" : "text"}
              inputMode={isPassword ? undefined : "numeric"}
              pattern={isPassword ? undefined : "[0-9]*"}
              autoComplete="off"
              maxLength={isPassword ? 72 : 4}
              value={confirm}
              onChange={(e) =>
                setConfirm(isPassword ? e.target.value : e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              disabled={busy}
              data-testid="reset-pin-confirm"
              className="mt-0.5 h-10 w-full rounded-card border border-border bg-surface-raised px-3 font-mono text-sm tracking-[0.15em] text-text outline-none focus:border-brand-navy"
            />
          </label>
          {secret && confirm && secret !== confirm ? (
            <p className="text-xs text-rose-700">Those don&rsquo;t match.</p>
          ) : null}
          <p className="text-xs text-text-muted">
            They sign in with their email + this {noun}. Text it to them once it&rsquo;s saved.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!canSave} data-testid="reset-pin-save">
              {busy ? "Saving…" : `Save ${noun}`}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function SectionHeading({ noun }: { noun: string }) {
  return (
    <h3 className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
      Login {noun}
    </h3>
  );
}
