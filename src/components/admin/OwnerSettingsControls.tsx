"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { StatusChip } from "@/components/ui/StatusChip";
import type { SettingItem } from "@/domains/platform/owner-console";

/**
 * Per-feature config knobs for the Owner Console (#760 PR2) — the client island
 * the server-rendered console mounts when capabilities.settingsWrite is true.
 * Renders one input per setting by type (number/text/toggle/enum), grouped by
 * feature, and saves via PUT /api/owner-settings (owner-gated, CAS, audited).
 * Saves are optimistic and roll back with a visible error on failure.
 *
 * The row is props-only and effect-free (SSR-render-testable); the wrapper owns
 * the shared feature-settings.json revision (CAS token) + in-flight state.
 */

type SettingValue = number | string | boolean;

function idOf(featureKey: string, key: string) {
  return `${featureKey}.${key}`;
}

/** Small inline switch (mirrors OwnerFlagRow's). */
function Switch({
  on,
  disabled,
  testid,
  label,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  testid: string;
  label: string;
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

/** Props-only setting row (no effects) — SSR-render-testable. */
export function OwnerSettingRow({
  setting,
  saving,
  onSave,
}: {
  setting: SettingItem;
  saving: boolean;
  onSave: (value: SettingValue) => void;
}) {
  const id = idOf(setting.featureKey, setting.key);
  const isNumber = setting.type === "number";
  const isString = setting.type === "string";
  const [draft, setDraft] = useState<string>(String(setting.value));
  const dirty = (isNumber || isString) && draft !== String(setting.value);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      data-testid={`setting-row-${id}`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-text">
          {setting.label}
          <StatusChip tone={setting.source === "override" ? "info" : "neutral"} dot={false}>
            {setting.source === "override" ? "custom" : "default"}
          </StatusChip>
        </p>
        <p className="mt-0.5 text-xs text-text-muted">{setting.description}</p>
        <p className="mt-0.5 text-xs text-text-muted">
          <span className="font-mono">{id}</span> · default {String(setting.default)}
          {setting.unit ? ` ${setting.unit}` : ""}
          {isNumber && setting.min != null && setting.max != null
            ? ` · range ${setting.min}–${setting.max}`
            : ""}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {setting.type === "boolean" ? (
          <Switch
            on={setting.value === true}
            disabled={saving}
            testid={`setting-input-${id}`}
            label={setting.label}
            onToggle={() => onSave(!(setting.value === true))}
          />
        ) : setting.type === "enum" ? (
          <select
            value={String(setting.value)}
            disabled={saving}
            data-testid={`setting-input-${id}`}
            onChange={(e) => onSave(e.target.value)}
            className="rounded-card border border-border bg-surface-raised px-2 py-1 text-sm text-text disabled:opacity-50"
          >
            {(setting.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              type={isNumber ? "number" : "text"}
              value={draft}
              disabled={saving}
              min={setting.min ?? undefined}
              max={setting.max ?? undefined}
              step={setting.step ?? undefined}
              maxLength={setting.maxLength ?? undefined}
              data-testid={`setting-input-${id}`}
              onChange={(e) => setDraft(e.target.value)}
              className="w-28 rounded-card border border-border bg-surface-raised px-2 py-1 text-sm text-text disabled:opacity-50"
            />
            {setting.unit ? <span className="text-xs text-text-muted">{setting.unit}</span> : null}
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={() => onSave(isNumber ? Number(draft) : draft)}
              data-testid={`setting-save-${id}`}
              className="rounded-card border border-border px-2.5 py-1 text-xs text-text hover:bg-surface-subtle disabled:opacity-50"
            >
              Save
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Stateful wrapper — owns the shared CAS rev + optimistic saves, grouped by feature. */
export function OwnerSettingsControls({ items, rev }: { items: SettingItem[]; rev?: number }) {
  const [rows, setRows] = useState<SettingItem[]>(items);
  const [currentRev, setCurrentRev] = useState<number | undefined>(rev);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(featureKey: string, key: string, value: SettingValue) {
    const id = idOf(featureKey, key);
    if (savingId) return;
    const before = rows.find((r) => r.featureKey === featureKey && r.key === key);
    if (!before) return;

    setSavingId(id);
    setError(null);
    setRows((prev) =>
      prev.map((r) => (r.featureKey === featureKey && r.key === key ? { ...r, value, source: "override" } : r)),
    );

    try {
      const res = await fetch("/api/owner-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureKey, key, value, expectedRev: currentRev }),
      });
      const data: { code?: string; error?: string; rev?: number; resolved?: SettingValue } = await res
        .json()
        .catch(() => ({}));

      if (!res.ok) {
        setRows((prev) => prev.map((r) => (r.featureKey === featureKey && r.key === key ? before : r)));
        setError(
          data.code === "stale_write"
            ? "Settings changed elsewhere — reload the page to get the latest, then retry."
            : data.error || "Couldn't save that setting. Try again.",
        );
        return;
      }

      setRows((prev) =>
        prev.map((r) =>
          r.featureKey === featureKey && r.key === key
            ? { ...r, value: data.resolved ?? value, source: "override" }
            : r,
        ),
      );
      if (Number.isFinite(data.rev)) setCurrentRev(data.rev);
    } catch {
      setRows((prev) => prev.map((r) => (r.featureKey === featureKey && r.key === key ? before : r)));
      setError("Couldn't save that setting. Check your connection and try again.");
    } finally {
      setSavingId(null);
    }
  }

  // Group rows by feature, preserving registry order.
  const groups: Array<{ featureKey: string; list: SettingItem[] }> = [];
  for (const r of rows) {
    let g = groups.find((x) => x.featureKey === r.featureKey);
    if (!g) {
      g = { featureKey: r.featureKey, list: [] };
      groups.push(g);
    }
    g.list.push(r);
  }

  return (
    <div data-testid="owner-settings-controls" className="space-y-3">
      {error ? (
        <div
          role="alert"
          data-testid="owner-settings-error"
          className="rounded-card border-l-2 border-l-state-danger bg-surface-raised px-4 py-2 text-sm text-text"
        >
          {error}
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.featureKey} className="overflow-hidden rounded-card border border-border">
          <div className="border-b border-border bg-surface-subtle px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-text-muted">
            {g.featureKey}
          </div>
          <div className="divide-y divide-border">
            {g.list.map((s) => (
              <OwnerSettingRow
                key={idOf(s.featureKey, s.key)}
                setting={s}
                saving={savingId === idOf(s.featureKey, s.key)}
                onSave={(v) => save(s.featureKey, s.key, v)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
