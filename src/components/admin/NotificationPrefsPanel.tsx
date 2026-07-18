"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  NOTIFICATION_PREF_META,
  applyServerEcho,
  defaultPrefs,
  optimisticToggle,
  parsePrefsResponse,
  rollback,
  type NotificationPrefMeta,
  type NotificationPrefs,
} from "@/domains/platform/notification-prefs";
import type { NotificationPrefKey } from "@/domains/platform/notification-item";

/**
 * Notification preferences panel (#218) — per-type toggles over the existing
 * self-only `GET`/`PUT /api/notification-prefs`. A small client island: it
 * loads the current prefs, flips OPTIMISTICALLY, and ROLLS BACK with a visible
 * error chip if the `PUT` fails (a silent rollback reads as a broken switch).
 *
 * No new endpoints — it speaks only the existing prefs API. Defaults are
 * applied client-side too (`parsePrefsResponse`), so a partial/empty payload
 * never shows "off" for a pref the server treats as on. The optimistic/rollback
 * transitions live as PURE helpers in the domain so they're unit-tested without
 * a DOM; this component is a thin shell over them + the props-only row below.
 */

type LoadState = "loading" | "ready" | "error";

/** Props-only toggle row (no effects) — SSR-render-testable. */
export function NotificationPrefRow({
  meta,
  on,
  disabled,
  onToggle,
}: {
  meta: NotificationPrefMeta;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-start justify-between gap-4 rounded-card border border-border bg-surface-raised p-4">
      <div className="min-w-0">
        <p className="font-medium text-text">{meta.label}</p>
        <p className="mt-0.5 text-sm text-text-muted">{meta.description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={meta.label}
        data-testid={`toggle-${meta.key}`}
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
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
    </li>
  );
}

export function NotificationPrefsPanel({
  hiddenKeys = [],
}: {
  /** Pref rows to hide — kinds whose FEATURE is currently hidden (lean reset):
   *  the server page resolves the feature flags and passes e.g. the snag kinds
   *  here so the panel never advertises a push type the product can't send. */
  hiddenKeys?: ReadonlyArray<NotificationPrefKey>;
} = {}) {
  const visibleMeta = NOTIFICATION_PREF_META.filter((m) => !hiddenKeys.includes(m.key));
  const [prefs, setPrefs] = useState<NotificationPrefs>(defaultPrefs);
  const [load, setLoad] = useState<LoadState>("loading");
  // One toggle in flight at a time; per-attempt error chip.
  const [saving, setSaving] = useState<NotificationPrefKey | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/notification-prefs", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const parsed = parsePrefsResponse(await res.json());
        if (!alive) return;
        if (!parsed) {
          setLoad("error");
          return;
        }
        setPrefs(parsed);
        setLoad("ready");
      } catch {
        if (alive) setLoad("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(key: NotificationPrefKey) {
    if (saving) return;
    const previous = prefs[key];

    setPrefs((p) => optimisticToggle(p, key));
    setSaving(key);
    setSaveError(null);

    try {
      const res = await fetch("/api/notification-prefs", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: !previous }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const echo = parsePrefsResponse(await res.json());
      setPrefs((p) => applyServerEcho(p, echo));
    } catch {
      setPrefs((p) => rollback(p, key, previous));
      setSaveError("Couldn't save that change. Check your connection and try again.");
    } finally {
      setSaving(null);
    }
  }

  if (load === "loading") {
    return (
      <div data-testid="notification-prefs-loading" className="space-y-3" aria-busy="true">
        {visibleMeta.map((m) => (
          <div
            key={m.key}
            className="h-16 animate-pulse rounded-card border border-border bg-surface-subtle"
          />
        ))}
      </div>
    );
  }

  if (load === "error") {
    return (
      <div
        data-testid="notification-prefs-error"
        role="alert"
        className="rounded-card border-l-2 border-l-state-danger bg-surface-raised p-4 text-sm text-text"
      >
        {"We couldn't load your notification settings right now. Refresh to try again."}
      </div>
    );
  }

  return (
    <div data-testid="notification-prefs-panel" className="space-y-3">
      {saveError ? (
        <div
          data-testid="notification-prefs-save-error"
          role="alert"
          className="rounded-card border-l-2 border-l-state-danger bg-surface-raised px-4 py-2 text-sm text-text"
        >
          {saveError}
        </div>
      ) : null}

      <ul className="space-y-2">
        {visibleMeta.map((meta) => (
          <NotificationPrefRow
            key={meta.key}
            meta={meta}
            on={prefs[meta.key]}
            disabled={saving === meta.key}
            onToggle={() => toggle(meta.key)}
          />
        ))}
      </ul>
    </div>
  );
}
