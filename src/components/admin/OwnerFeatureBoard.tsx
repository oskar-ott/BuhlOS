"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { type FlagItem } from "@/domains/platform/owner-console";
import { OwnerFlagRow, optimistic } from "./OwnerFlagRow";

/**
 * Owner Feature Control Board (#760) — the honest recreation of the prototype's
 * feature board. Product features grouped by DOMAIN, each with the two-dial
 * control from OwnerFlagRow (Live to customers / Preview for me). Filters by
 * exposure + surface; turning a live feature OFF for customers goes through a
 * reduce-exposure confirm (optional reason → audit). Protected data-plane flags
 * render in a collapsed, read-only "System" group.
 *
 * State lives here (one shared flags.json rev + optimistic write, reusing the
 * pure `optimistic` projection); rows are the effect-free OwnerFlagRow.
 */

type Scope = "customer" | "ownerPreview";
type Exposure = "all" | "on" | "preview" | "off";

const EXPOSURE_FILTERS: ReadonlyArray<readonly [Exposure, string]> = [
  ["all", "All"],
  ["on", "On"],
  ["preview", "Preview only"],
  ["off", "Off"],
];

/** A feature's current exposure (customer-visible > owner-only > off). */
function exposureOf(f: FlagItem): Exclude<Exposure, "all"> {
  if (f.resolved) return "on";
  if (f.resolvedForOwner) return "preview";
  return "off";
}

export function OwnerFeatureBoard({ items, rev }: { items: FlagItem[]; rev?: number }) {
  const [rows, setRows] = useState<FlagItem[]>(items);
  const [currentRev, setCurrentRev] = useState<number | undefined>(rev);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expo, setExpo] = useState<Exposure>("all");
  const [surface, setSurface] = useState<string>("all");
  const [confirm, setConfirm] = useState<{ key: string; label: string } | null>(null);
  const [reason, setReason] = useState("");

  async function doWrite(key: string, scope: Scope, value: boolean | null, why?: string) {
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
        body: JSON.stringify({ key, scope, value, expectedRev: currentRev, reason: why }),
      });
      const data: {
        code?: string;
        error?: string;
        rev?: number;
        resolved?: { customer: boolean; owner: boolean };
      } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRows((prev) => prev.map((r) => (r.key === key ? before : r)));
        setError(
          data.code === "stale_write"
            ? "These flags changed elsewhere — reload the page to get the latest, then retry."
            : data.error || "Couldn't save that change. Try again.",
        );
        return;
      }
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
      setRows((prev) => prev.map((r) => (r.key === key ? before : r)));
      setError("Couldn't save that change. Check your connection and try again.");
    } finally {
      setSavingKey(null);
    }
  }

  // Reducing exposure (turning a customer-visible feature OFF) → confirm first.
  function handleWrite(key: string, scope: Scope, value: boolean | null) {
    const row = rows.find((r) => r.key === key);
    if (row && scope === "customer" && value === false && row.resolved) {
      setReason("");
      setConfirm({ key, label: row.label || row.key });
      return;
    }
    void doWrite(key, scope, value);
  }

  const surfaces = useMemo(
    () =>
      Array.from(
        new Set(rows.filter((r) => !r.protected && r.surface).map((r) => r.surface as string)),
      ),
    [rows],
  );

  const visible = rows
    .filter((r) => !r.protected)
    .filter((r) => expo === "all" || exposureOf(r) === expo)
    .filter((r) => surface === "all" || r.surface === surface);

  const groups: Array<{ domain: string; items: FlagItem[] }> = [];
  for (const r of visible) {
    const d = r.domain || "Other";
    let g = groups.find((x) => x.domain === d);
    if (!g) {
      g = { domain: d, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }
  const systemRows = rows.filter((r) => r.protected);

  return (
    <div data-testid="owner-feature-board" className="space-y-4">
      {error ? (
        <div
          role="alert"
          data-testid="owner-board-error"
          className="rounded-card border-l-2 border-l-state-danger bg-surface-raised px-4 py-2 text-sm text-text"
        >
          {error}
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="inline-flex overflow-hidden rounded-card border border-border">
          {EXPOSURE_FILTERS.map(([k, t]) => (
            <button
              key={k}
              type="button"
              onClick={() => setExpo(k)}
              className={cn(
                "px-2.5 py-1",
                expo === k ? "bg-brand-navy text-white" : "text-text-muted hover:text-text",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        {surfaces.length > 1 ? (
          <div className="inline-flex overflow-hidden rounded-card border border-border">
            {["all", ...surfaces].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSurface(s)}
                className={cn(
                  "px-2.5 py-1",
                  surface === s ? "bg-brand-navy text-white" : "text-text-muted hover:text-text",
                )}
              >
                {s === "all" ? "All surfaces" : s}
              </button>
            ))}
          </div>
        ) : null}
        <span className="text-text-muted">{visible.length} shown</span>
      </div>

      {/* Domain groups */}
      {groups.map((g) => (
        <div key={g.domain} data-testid={`board-domain-${g.domain}`}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
            {g.domain}
          </h3>
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {g.items.map((f) => (
              <OwnerFlagRow
                key={f.key}
                flag={f}
                saving={savingKey === f.key}
                onWrite={(scope, value) => handleWrite(f.key, scope, value)}
              />
            ))}
          </div>
        </div>
      ))}
      {visible.length === 0 ? (
        <p className="text-sm text-text-muted">No features match this filter.</p>
      ) : null}

      {/* Protected data-plane flags — read-only */}
      {systemRows.length ? (
        <details className="overflow-hidden rounded-card border border-border">
          <summary className="cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            System · data-plane ({systemRows.length}) — read-only
          </summary>
          <div className="divide-y divide-border border-t border-border">
            {systemRows.map((f) => (
              <OwnerFlagRow key={f.key} flag={f} saving={false} onWrite={() => {}} />
            ))}
          </div>
        </details>
      ) : null}

      {/* Reduce-exposure confirm */}
      {confirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Turn ${confirm.label} off for customers`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-card border border-border bg-surface-raised p-5 shadow-lg">
            <h4 className="font-display text-lg text-text">
              Turn &ldquo;{confirm.label}&rdquo; off for customers?
            </h4>
            <p className="mt-2 text-sm text-text-muted">
              Customers will no longer see this feature — its pages, nav entries and cards
              disappear. Existing data is kept; you can turn it back on any time.
            </p>
            <label className="mt-3 block text-xs uppercase tracking-wider text-text-muted">
              Reason (optional — recorded in the audit log)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                data-testid="board-confirm-reason"
                className="mt-1 w-full rounded-card border border-border bg-surface-subtle px-3 py-2 text-sm text-text"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded-card border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="board-confirm-off"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void doWrite(c.key, "customer", false, reason.trim() || undefined);
                }}
                className="rounded-card bg-state-danger px-3 py-1.5 text-sm font-medium text-white"
              >
                Turn off
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
