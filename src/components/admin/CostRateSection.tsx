"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { costRatesFor, setCostRate } from "@/domains/cost-rates/client";
import {
  dollarsToCents,
  formatCents,
  type CostRateEntry,
} from "@/domains/cost-rates/schema";

/**
 * "Cost rate (admin only)" inside the employee detail drawer (#304). The
 * confidential LOADED-COST rate lives outside users.json and is admin-tier only
 * — a leading hand can never see a mate's pay. Edits APPEND an effective-dated
 * entry (never overwrite), so a past week is always costed at the rate effective
 * then, and the editor + timestamp are preserved.
 *
 * Records key on the users.json userId — a worker who hasn't finished Phil setup
 * has nowhere to hang a rate yet (honest note, never a fake 0).
 */

interface CostRateSectionProps {
  userId: string | null;
  workerName: string;
}

interface FormState {
  costRate: string; // dollars, e.g. "52.50"
  chargeOutRate: string;
  effectiveFrom: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CostRateSection({ userId, workerName }: CostRateSectionProps) {
  const [history, setHistory] = useState<CostRateEntry[] | null>(null);
  const [current, setCurrent] = useState<CostRateEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      const res = await costRatesFor(userId);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.error.message);
        setHistory([]);
        return;
      }
      setHistory(res.data.history);
      setCurrent(res.data.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) {
    return (
      <section>
        <SectionHeading />
        <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
          A cost rate can be set once {workerName} finishes Phil setup — it keys
          off their worker account.
        </p>
      </section>
    );
  }

  async function save() {
    if (!form || !userId) return;
    const costRateCents = dollarsToCents(form.costRate);
    if (costRateCents == null) {
      setActionError("Enter a loaded cost rate like 52.50");
      return;
    }
    let chargeOutRateCents: number | null = null;
    if (form.chargeOutRate.trim()) {
      chargeOutRateCents = dollarsToCents(form.chargeOutRate);
      if (chargeOutRateCents == null) {
        setActionError("Charge-out rate must be a money value like 95.00");
        return;
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom)) {
      setActionError("Pick an effective-from date");
      return;
    }
    setBusy(true);
    setActionError(null);
    const res = await setCostRate({
      userId,
      costRateCents,
      chargeOutRateCents,
      effectiveFrom: form.effectiveFrom,
    });
    setBusy(false);
    if (!res.ok) {
      setActionError(res.error.message);
      return;
    }
    setHistory(res.data.history);
    setCurrent(res.data.current);
    setForm(null);
  }

  const inputClass = "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm";

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionHeading />
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            setForm(form ? null : { costRate: "", chargeOutRate: "", effectiveFrom: todayIso() })
          }
          data-testid="cost-rate-add-open"
        >
          {history && history.length ? "New rate" : "Set rate"}
        </Button>
      </div>

      {loadError ? <p className="mb-2 text-xs text-text-muted">{loadError}</p> : null}
      {actionError ? (
        <p
          role="alert"
          className="mb-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
        >
          {actionError}
        </p>
      ) : null}

      {form ? (
        <div className="mb-2 grid gap-2 rounded-card border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-text-muted">
              Loaded cost $/h
              <input
                type="text"
                inputMode="decimal"
                value={form.costRate}
                onChange={(e) => setForm({ ...form, costRate: e.target.value })}
                placeholder="52.50"
                className={inputClass}
                aria-label="Loaded cost rate (dollars per hour)"
                data-testid="cost-rate-cost"
              />
            </label>
            <label className="block text-xs text-text-muted">
              Charge-out $/h (optional)
              <input
                type="text"
                inputMode="decimal"
                value={form.chargeOutRate}
                onChange={(e) => setForm({ ...form, chargeOutRate: e.target.value })}
                placeholder="95.00"
                className={inputClass}
                aria-label="Charge-out rate (dollars per hour)"
              />
            </label>
          </div>
          <label className="block text-xs text-text-muted">
            Effective from
            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              className={inputClass}
              data-testid="cost-rate-effective"
            />
          </label>
          <p className="text-[11px] text-text-muted">
            Appends history — a past week stays costed at the rate effective then.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy} data-testid="cost-rate-save">
              Save rate
            </Button>
          </div>
        </div>
      ) : null}

      {history === null ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : history.length === 0 ? (
        <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
          No cost rate yet — job profitability understates {workerName}&rsquo;s labour
          until one is set.
        </p>
      ) : (
        <>
          <div className="rounded-card border border-border bg-surface px-3 py-2" data-testid="cost-rate-current">
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Current loaded cost
            </div>
            <div className="mt-0.5 text-sm font-medium text-text">
              {current ? `${formatCents(current.costRateCents)} / h` : "— (none effective yet)"}
              {current?.chargeOutRateCents != null
                ? ` · charge-out ${formatCents(current.chargeOutRateCents)} / h`
                : ""}
            </div>
          </div>
          <ul className="mt-2 divide-y divide-border rounded-card border border-border">
            {history
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-text">
                      {formatCents(e.costRateCents)} / h
                      {e.chargeOutRateCents != null
                        ? ` · CO ${formatCents(e.chargeOutRateCents)}`
                        : ""}
                    </span>
                    <span className="font-mono text-[11px] text-text-muted">
                      from {e.effectiveFrom}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-text-muted">
                    set by {e.setByName || e.setBy || "—"}
                  </div>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SectionHeading() {
  return (
    <h3 className="font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
      Cost rate (admin only)
    </h3>
  );
}
