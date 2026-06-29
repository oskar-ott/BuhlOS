"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { StatusChip } from "@/components/ui/StatusChip";
import { type FlagItem, expiryTone, flagSourceLabel } from "@/domains/platform/owner-console";

/**
 * Interactive feature-flag controls for the Owner Console (#760) — the client
 * island the server-rendered console mounts ONLY when capabilities.flagToggle
 * is true. Two dials per flag:
 *   • "Live to customers" → the launch gate (scope 'customer').
 *   • "Preview for me"     → owner-only override (scope 'ownerPreview') so the
 *     owner runs a feature live while customers can't see it.
 * Writes go to POST /api/owner-flags (owner-gated, CAS, audited); flips are
 * OPTIMISTIC and ROLL BACK with a visible error if the write fails (a silent
 * rollback reads as a broken switch). Protected (data-plane) flags render
 * read-only; env-pinned flags render disabled (env wins).
 *
 * The row is a props-only, effect-free component (SSR-render-testable); the list
 * wrapper owns the shared flags.json revision (CAS token) + in-flight state.
 */

type Scope = "customer" | "ownerPreview";

/** Props-only switch (no effects). */
function FlagSwitch({
  label,
  on,
  disabled,
  testid,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  testid: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testid}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        on ? "bg-brand-navy" : "bg-border",
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-surface-raised shadow transition-transform",
          on ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** Props-only flag row (no effects) — SSR-render-testable. */
export function OwnerFlagRow({
  flag,
  saving,
  onWrite,
}: {
  flag: FlagItem;
  saving: boolean;
  onWrite: (scope: Scope, value: boolean | null) => void;
}) {
  const envPinned = flag.source === "env";
  const customerOn = flag.resolved;
  const ownerOn = flag.resolvedForOwner;

  return (
    <div className="space-y-2 px-4 py-3" data-testid={`flag-row-${flag.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-text">{flag.key}</span>
        {flag.expiryStatus !== "ok" ? (
          <StatusChip tone={expiryTone(flag.expiryStatus)}>{flag.expiryStatus}</StatusChip>
        ) : null}
        {flag.protected ? (
          <StatusChip tone="neutral" dot={false}>
            protected
          </StatusChip>
        ) : null}
        {envPinned && !flag.protected ? (
          <StatusChip tone="warning" dot={false}>
            pinned by env
          </StatusChip>
        ) : null}
      </div>

      <p className="text-sm text-text-muted">{flag.description}</p>

      {/* Resolved dual-state — the honest "who sees this right now" line. */}
      <p className="text-xs text-text-muted">
        Customers: <span className="text-text">{customerOn ? "visible" : "hidden"}</span> · You:{" "}
        <span className="text-text">{ownerOn ? "visible" : "hidden"}</span> · Source:{" "}
        {flagSourceLabel(flag.ownerSource)} · target: {flag.target} · expires {flag.expires}
      </p>

      {flag.protected ? (
        <p className="text-xs text-text-muted">
          Data-plane flag — ops-only (set via env / deployment). Read-only here.
        </p>
      ) : envPinned ? (
        <p className="text-xs text-text-muted">
          Pinned by <span className="font-mono">FLAG_{flag.key.toUpperCase()}</span> — change it in
          deployment settings; the env value always wins.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-0.5">
          <label className="flex items-center gap-2 text-sm text-text">
            <FlagSwitch
              label={`Live to customers — ${flag.key}`}
              on={customerOn}
              disabled={saving}
              testid={`flag-customer-${flag.key}`}
              onToggle={() => onWrite("customer", !customerOn)}
            />
            Live to customers
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <FlagSwitch
              label={`Preview for me — ${flag.key}`}
              on={ownerOn}
              disabled={saving}
              testid={`flag-preview-${flag.key}`}
              onToggle={() => onWrite("ownerPreview", !ownerOn)}
            />
            Preview for me
          </label>
          {flag.ownerPreview !== null ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => onWrite("ownerPreview", null)}
              data-testid={`flag-reset-${flag.key}`}
              className="text-xs text-text-muted underline underline-offset-2 hover:text-text disabled:opacity-50"
            >
              Reset preview to baseline
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Stateful list wrapper — owns the shared CAS rev + optimistic writes. */
export function OwnerFlagList({ items, rev }: { items: FlagItem[]; rev?: number }) {
  const [rows, setRows] = useState<FlagItem[]>(items);
  const [currentRev, setCurrentRev] = useState<number | undefined>(rev);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function write(key: string, scope: Scope, value: boolean | null) {
    if (savingKey) return;
    const before = rows.find((r) => r.key === key);
    if (!before) return;

    setSavingKey(key);
    setError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? optimistic(r, scope, value) : r)));

    try {
      const res = await fetch("/api/owner-flags", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, scope, value, expectedRev: currentRev }),
      });
      const data: {
        code?: string;
        error?: string;
        rev?: number;
        resolved?: { customer: boolean; owner: boolean };
      } = await res.json().catch(() => ({}));

      if (!res.ok) {
        setRows((prev) => prev.map((r) => (r.key === key ? before : r))); // rollback
        if (data.code === "stale_write") {
          setError("These flags changed elsewhere — reload the page to get the latest, then retry.");
        } else {
          setError(data.error || "Couldn't save that change. Try again.");
        }
        return;
      }

      // Apply the server's authoritative resolved values + new CAS rev.
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? {
                ...optimistic(r, scope, value),
                resolved: data.resolved ? data.resolved.customer : r.resolved,
                resolvedForOwner: data.resolved ? data.resolved.owner : r.resolvedForOwner,
              }
            : r,
        ),
      );
      if (Number.isFinite(data.rev)) setCurrentRev(data.rev);
    } catch {
      setRows((prev) => prev.map((r) => (r.key === key ? before : r))); // rollback
      setError("Couldn't save that change. Check your connection and try again.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div data-testid="owner-flag-list" className="space-y-3">
      {error ? (
        <div
          role="alert"
          data-testid="owner-flag-error"
          className="rounded-card border-l-2 border-l-state-danger bg-surface-raised px-4 py-2 text-sm text-text"
        >
          {error}
        </div>
      ) : null}
      <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
        {rows.map((f) => (
          <OwnerFlagRow
            key={f.key}
            flag={f}
            saving={savingKey === f.key}
            onWrite={(scope, value) => write(f.key, scope, value)}
          />
        ))}
      </div>
    </div>
  );
}

/** Pure optimistic projection of a single write onto a row (server echo then
 *  corrects resolved/resolvedForOwner). Exported for unit testing. */
export function optimistic(r: FlagItem, scope: Scope, value: boolean | null): FlagItem {
  if (scope === "customer") {
    const resolved = value === null ? r.default : value;
    const source = value === null ? "default" : "override";
    const resolvedForOwner = r.ownerPreview === null ? resolved : r.resolvedForOwner;
    const ownerSource = r.ownerPreview !== null ? "owner-preview" : source;
    return { ...r, resolved, source, resolvedForOwner, ownerSource };
  }
  // ownerPreview
  const ownerPreview = value;
  const resolvedForOwner = ownerPreview === null ? r.resolved : ownerPreview;
  const ownerSource = ownerPreview !== null ? "owner-preview" : r.source;
  return { ...r, ownerPreview, resolvedForOwner, ownerSource };
}
