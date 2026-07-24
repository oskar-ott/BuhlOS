"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { type FlagItem } from "@/domains/platform/owner-console";
import { OwnerFlagRow } from "./OwnerFlagRow";
import { OwnerFeatureRow, type Rollout } from "./OwnerFeatureRow";
import { pctWidthClass } from "@/components/admin/pct-width";

/**
 * Owner Feature Control Board (#760). Product features grouped by DOMAIN, each
 * with the EASY staged-rollout control (Off · Preview · Live) from
 * OwnerFeatureRow — one atomic write moves a feature from hidden → owner-only
 * test → released to everyone. The rollout-mix bar at the top shows the real
 * Live/Preview/Off split and its legend doubles as the exposure filter; a
 * search box narrows by name or key; MOVING A LIVE FEATURE BACK (to preview or
 * off) goes through a reduce-exposure confirm (optional reason → audit).
 * Protected data-plane flags stay in a collapsed, read-only "System" group
 * (the two-dial OwnerFlagRow, no interaction).
 *
 * State lives here (one shared flags.json rev + optimistic write); the rows are
 * effect-free.
 */

type Exposure = "all" | "on" | "preview" | "off";

/** A feature's current exposure (customer-visible > owner-only > off). */
function exposureOf(f: FlagItem): Exclude<Exposure, "all"> {
  if (f.resolved) return "on";
  if (f.resolvedForOwner) return "preview";
  return "off";
}

/** Pure optimistic projection of a staged-rollout write onto a row (the server
 *  echo then corrects resolved/resolvedForOwner). */
function optimisticRollout(r: FlagItem, state: Rollout): FlagItem {
  if (state === "live") {
    return { ...r, resolved: true, resolvedForOwner: true, ownerPreview: null, source: "override", ownerSource: "override" };
  }
  if (state === "preview") {
    return { ...r, resolved: false, resolvedForOwner: true, ownerPreview: true, source: "override", ownerSource: "owner-preview" };
  }
  return { ...r, resolved: false, resolvedForOwner: false, ownerPreview: false, source: "override", ownerSource: "override" };
}

export function OwnerFeatureBoard({ items, rev }: { items: FlagItem[]; rev?: number }) {
  const [rows, setRows] = useState<FlagItem[]>(items);
  const [currentRev, setCurrentRev] = useState<number | undefined>(rev);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expo, setExpo] = useState<Exposure>("all");
  const [surface, setSurface] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{
    key: string;
    label: string;
    core: boolean;
    target: Rollout;
  } | null>(null);
  const [reason, setReason] = useState("");

  async function doRollout(key: string, state: Rollout, why?: string) {
    if (savingKey) return;
    const before = rows.find((r) => r.key === key);
    if (!before) return;
    setSavingKey(key);
    setError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? optimisticRollout(r, state) : r)));
    try {
      const res = await fetch("/api/owner-flags", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, rollout: state, expectedRev: currentRev, reason: why }),
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
            ? "These features changed elsewhere — reload the page to get the latest, then retry."
            : data.error || "Couldn't save that change. Try again.",
        );
        return;
      }
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? {
                ...optimisticRollout(r, state),
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

  // Reducing a LIVE feature's exposure (Live → Preview or Off) → confirm first.
  // Releasing (→ Live) or starting a preview (Off → Preview) is one click.
  function handleRollout(key: string, target: Rollout) {
    const row = rows.find((r) => r.key === key);
    if (row && row.resolved && target !== "live") {
      setReason("");
      setConfirm({ key, label: row.label || row.key, core: !!row.core, target });
      return;
    }
    void doRollout(key, target);
  }

  const surfaces = useMemo(
    () =>
      Array.from(
        new Set(rows.filter((r) => !r.protected && r.surface).map((r) => r.surface as string)),
      ),
    [rows],
  );

  const product = rows.filter((r) => !r.protected);
  const mix = {
    on: product.filter((r) => exposureOf(r) === "on").length,
    preview: product.filter((r) => exposureOf(r) === "preview").length,
    off: product.filter((r) => exposureOf(r) === "off").length,
  };

  const q = query.trim().toLowerCase();
  const visible = product
    .filter((r) => expo === "all" || exposureOf(r) === expo)
    .filter((r) => surface === "all" || r.surface === surface)
    .filter(
      (r) =>
        q === "" ||
        r.key.toLowerCase().includes(q) ||
        (r.label ?? "").toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );

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

  const MIX_LEGEND: ReadonlyArray<{ expo: Exposure; label: string; count: number; swatch: string }> = [
    { expo: "all", label: "All", count: product.length, swatch: "" },
    { expo: "on", label: "Live", count: mix.on, swatch: "bg-emerald-500" },
    { expo: "preview", label: "Preview", count: mix.preview, swatch: "bg-sky-500" },
    { expo: "off", label: "Off", count: mix.off, swatch: "bg-border-strong" },
  ];

  return (
    <div data-testid="owner-feature-board" className="space-y-4">
      <p className="text-sm text-text-muted">
        Move any feature through its launch: <strong className="text-text">Off</strong> (hidden) →{" "}
        <strong className="text-text">Preview</strong> (only you see it — build &amp; test it live)
        → <strong className="text-text">Live</strong> (everyone). Turning a live feature back asks
        you to confirm.
      </p>

      {error ? (
        <div
          role="alert"
          data-testid="owner-board-error"
          className="rounded-card border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900"
        >
          {error}
        </div>
      ) : null}

      {/* Rollout mix — real proportions; the legend IS the exposure filter. */}
      {product.length > 0 ? (
        <div className="rounded-card border border-border bg-surface-raised p-4">
          <div
            aria-hidden="true"
            className="flex h-2 overflow-hidden rounded-pill bg-surface-subtle"
          >
            {mix.on > 0 ? (
              <span className={cn("bg-emerald-500", pctWidthClass(mix.on, product.length))} />
            ) : null}
            {mix.preview > 0 ? (
              <span className={cn("bg-sky-500", pctWidthClass(mix.preview, product.length))} />
            ) : null}
            {mix.off > 0 ? (
              <span className={cn("bg-border-strong", pctWidthClass(mix.off, product.length))} />
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {MIX_LEGEND.map((l) => (
              <button
                key={l.expo}
                type="button"
                aria-pressed={expo === l.expo}
                onClick={() => setExpo(l.expo)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium transition-colors",
                  expo === l.expo
                    ? "bg-brand-navy text-white"
                    : "border border-border text-text-muted hover:bg-surface-subtle hover:text-text",
                )}
              >
                {l.swatch ? (
                  <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", l.swatch)} />
                ) : null}
                {l.label}
                <span className="font-mono tabular-nums opacity-70">{l.count}</span>
              </button>
            ))}

            {surfaces.length > 1 ? (
              <div className="ml-auto inline-flex overflow-hidden rounded-card border border-border text-xs">
                {["all", ...surfaces].map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={surface === s}
                    onClick={() => setSurface(s)}
                    className={cn(
                      "px-2.5 py-1 transition-colors",
                      surface === s
                        ? "bg-brand-navy text-white"
                        : "text-text-muted hover:bg-surface-subtle hover:text-text",
                    )}
                  >
                    {s === "all" ? "All surfaces" : s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="relative block max-w-xs flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted"
              />
              <span className="sr-only">Search features</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search features…"
                data-testid="board-search"
                className="w-full rounded-pill border border-border bg-surface-subtle py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-muted focus:border-border-strong focus:outline-none"
              />
            </label>
            <span className="text-xs text-text-muted">{visible.length} shown</span>
          </div>
        </div>
      ) : null}

      {/* Domain groups */}
      {groups.map((g) => {
        const gMix = {
          on: g.items.filter((r) => exposureOf(r) === "on").length,
          preview: g.items.filter((r) => exposureOf(r) === "preview").length,
        };
        return (
          <div key={g.domain} data-testid={`board-domain-${g.domain}`}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                {g.domain}
              </h3>
              <p className="font-mono text-[11px] tabular-nums text-text-muted">
                {gMix.on} live{gMix.preview ? ` · ${gMix.preview} preview` : ""} · {g.items.length}{" "}
                total
              </p>
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
              {g.items.map((f) => (
                <OwnerFeatureRow
                  key={f.key}
                  flag={f}
                  saving={savingKey === f.key}
                  onRollout={(state) => handleRollout(f.key, state)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {visible.length === 0 ? (
        <p className="text-sm text-text-muted">No features match this filter.</p>
      ) : null}

      {/* Protected data-plane flags — read-only */}
      {systemRows.length ? (
        <details className="group overflow-hidden rounded-card border border-border bg-surface-raised">
          <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-text-muted hover:bg-surface-subtle">
            System · data-plane ({systemRows.length}) — read-only
            <span aria-hidden="true" className="transition-transform group-open:rotate-180">
              ▾
            </span>
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
          aria-label={`Reduce ${confirm.label} exposure`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirm(null);
          }}
        >
          <div className="w-full max-w-md rounded-card border border-border bg-surface-raised p-5 shadow-raised">
            <h4 className="font-display text-lg text-text">
              {confirm.target === "off"
                ? `Turn "${confirm.label}" off for everyone?`
                : `Move "${confirm.label}" to preview (hide from customers)?`}
            </h4>
            <p className="mt-2 text-sm text-text-muted">
              {confirm.target === "off"
                ? "Customers and admins will no longer see this feature — its pages, nav entries and cards disappear."
                : "Customers and admins will no longer see this feature, but YOU still will — so you can keep testing it."}{" "}
              Existing data is kept; you can move it back any time.
            </p>
            {confirm.core ? (
              <p
                data-testid="board-confirm-core-warning"
                className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-900"
              >
                ⚠ This is a <strong>core</strong> surface — a load-bearing part of the product
                (jobs, hours or evidence). Most of the app depends on it. Only do this if you
                really mean to.
              </p>
            ) : null}
            <label className="mt-3 block text-xs uppercase tracking-wider text-text-muted">
              Reason (optional — recorded in the audit log)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                data-testid="board-confirm-reason"
                className="mt-1 w-full rounded-card border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-border-strong focus:outline-none"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded-card border border-border px-3 py-1.5 text-sm text-text transition-colors hover:bg-surface-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="board-confirm-off"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void doRollout(c.key, c.target, reason.trim() || undefined);
                }}
                className="rounded-card bg-state-danger px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                {confirm.target === "off" ? "Turn off" : "Move to preview"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
