"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { formatMoney } from "@/domains/quoting/totals";
import {
  createRatePreset,
  updateRatePreset,
  type RatePreset,
} from "@/domains/quoting/rate-presets-client";

/**
 * Labour rate-preset manager (#193) — create / list / archive the reusable
 * {loadedCostRate, sellRate} pairs the builder applies to labour lines. The
 * API (api/quote-rate-presets.js) enforces admin-tier writes + name
 * uniqueness; this is its first UI. Applying a preset snapshots its rates onto
 * the line, so editing/archiving here never changes an existing quote.
 */

interface QuoteRatePresetsModalProps {
  open: boolean;
  onClose: () => void;
  presets: RatePreset[];
  /** Called after a successful create/archive so the parent re-fetches. */
  onChanged: () => void;
}

const inputClass =
  "h-9 w-full rounded-card border border-border bg-surface px-2.5 text-sm text-text " +
  "focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy";

export function QuoteRatePresetsModal({ open, onClose, presets, onChanged }: QuoteRatePresetsModalProps) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function num(raw: string): number | null {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const costN = num(cost);
  const sellN = num(sell);
  const canCreate = name.trim().length > 0 && costN !== null && sellN !== null && !busy;

  async function onCreate() {
    if (!canCreate || costN === null || sellN === null) return;
    setBusy(true);
    setError(null);
    const res = await createRatePreset({ name: name.trim(), loadedCostRate: costN, sellRate: sellN });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setName("");
    setCost("");
    setSell("");
    onChanged();
  }

  async function onArchive(p: RatePreset) {
    setBusy(true);
    setError(null);
    const res = await updateRatePreset({ id: p.id, archived: true });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    onChanged();
  }

  const live = presets.filter((p) => !p.archived);

  return (
    <Modal open={open} onClose={onClose} title="Labour rate presets">
      <p className="text-sm text-text-muted">
        Reusable cost + sell rates for labour lines. Applying one copies its rates
        onto the line, so changing a preset never alters an existing quote.
      </p>

      {error ? (
        <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-border text-sm" data-testid="rate-presets-list">
        {live.length === 0 ? (
          <li className="py-2 text-text-muted">No presets yet — add one below.</li>
        ) : (
          live.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-text">{p.name}</span>{" "}
                <span className="text-text-muted">
                  cost {formatMoney(p.loadedCostRate)}/hr · sell {formatMoney(p.sellRate)}/hr
                </span>
              </span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onArchive(p)}>
                Archive
              </Button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-4 grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_7rem_7rem]">
        <input
          aria-label="Preset name"
          placeholder="e.g. Electrician"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          data-testid="rate-preset-name"
        />
        <input
          aria-label="Loaded cost rate per hour"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          placeholder="cost/hr"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className={inputClass}
          data-testid="rate-preset-cost"
        />
        <input
          aria-label="Sell rate per hour"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          placeholder="sell/hr"
          value={sell}
          onChange={(e) => setSell(e.target.value)}
          className={inputClass}
          data-testid="rate-preset-sell"
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Done
        </Button>
        <Button size="sm" onClick={onCreate} disabled={!canCreate} data-testid="rate-preset-create">
          Add preset
        </Button>
      </div>
    </Modal>
  );
}

/** Optional helper consumers can reuse for the picker label. */
export function presetLabel(p: RatePreset): string {
  return `${p.name} — cost ${formatMoney(p.loadedCostRate)} / sell ${formatMoney(p.sellRate)}`;
}
