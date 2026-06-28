"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { validateDailyThreshold } from "@/domains/platform/policy-schema";

/**
 * Hours-policy section (#222) — a self-fetching client island over
 * `GET`/`PUT /api/policy`. It exposes the ONE field the endpoint persists:
 * `hours.dailyThreshold` (a number in 1..24, the bounds `api/policy.js`
 * enforces). Save → PUT, then re-fetch and render `updatedAt`/`updatedBy`
 * provenance.
 *
 * HONEST scope (the issue's no-fake-card rule): this threshold governs the
 * LEGACY approvals bulk-approve / rate-flag rule. The v2 "Approve all" path
 * does NOT read it — #124 closed without adopting it and there are zero
 * `src/` consumers — so the copy says so plainly rather than implying the v2
 * board reacts to this number.
 *
 * No new endpoint, no api edits. `GET /api/policy` doesn't return `__rev` to
 * the client, so there's no optimistic-concurrency token here — the base ship
 * re-fetches after save (last-write-wins, same as legacy settings.html).
 *
 * `canEdit` is computed server-side from the admin-tier check and passed in;
 * `PUT /api/policy` is admin-tier server-side, so the page gate already admits
 * exactly the writers — but we still gate the button rather than render an
 * always-403 control.
 */

type LoadState = "loading" | "ready" | "error";

interface PolicyData {
  dailyThreshold: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

function parsePolicy(json: unknown): PolicyData | null {
  if (!json || typeof json !== "object") return null;
  const policy = (json as { policy?: unknown }).policy;
  if (!policy || typeof policy !== "object") return null;
  const p = policy as {
    hours?: { dailyThreshold?: unknown };
    updatedAt?: unknown;
    updatedBy?: unknown;
  };
  const n = p.hours?.dailyThreshold;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return {
    dailyThreshold: n,
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    updatedBy: typeof p.updatedBy === "string" ? p.updatedBy : null,
  };
}

function formatUpdated(data: PolicyData): string | null {
  if (!data.updatedAt) return null;
  const when = new Date(data.updatedAt);
  const stamp = Number.isNaN(when.getTime())
    ? data.updatedAt
    : when.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
  return data.updatedBy ? `Last changed ${stamp} by ${data.updatedBy}.` : `Last changed ${stamp}.`;
}

export function HoursPolicySection({ canEdit }: { canEdit: boolean }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [data, setData] = useState<PolicyData | null>(null);
  const [value, setValue] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/policy", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const parsed = parsePolicy(await res.json());
        if (!alive) return;
        if (!parsed) {
          setLoad("error");
          return;
        }
        setData(parsed);
        setValue(String(parsed.dailyThreshold));
        setLoad("ready");
      } catch {
        if (alive) setLoad("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const check = validateDailyThreshold(value === "" ? Number.NaN : Number(value));
  const valid = check.ok;
  const dirty = data !== null && value !== String(data.dailyThreshold);

  async function save() {
    if (!check.ok) return;
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const res = await fetch("/api/policy", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: { dailyThreshold: check.value } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.error) || `Save failed (${res.status})`);
      }
      // Re-fetch is implicit in the echo: the PUT returns the merged policy.
      const parsed = parsePolicy(await res.json());
      if (parsed) {
        setData(parsed);
        setValue(String(parsed.dailyThreshold));
      }
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (load === "loading") {
    return (
      <div
        data-testid="hours-policy-loading"
        className="space-y-3"
        aria-busy="true"
      >
        <div className="h-9 w-40 animate-pulse rounded-card border border-border bg-surface-subtle" />
        <div className="h-4 w-64 animate-pulse rounded-card bg-surface-subtle" />
      </div>
    );
  }

  if (load === "error" || !data) {
    return (
      <div
        data-testid="hours-policy-error"
        role="alert"
        className="rounded-card border-l-2 border-l-state-danger bg-surface-raised p-4 text-sm text-text"
      >
        {"We couldn't load the hours policy right now. Refresh to try again."}
      </div>
    );
  }

  const updatedLine = formatUpdated(data);

  return (
    <div data-testid="hours-policy-panel" className="space-y-4">
      <div>
        <label htmlFor="hours-daily-threshold" className="block text-sm font-medium text-text">
          Daily hours threshold
        </label>
        <p className="mt-1 text-sm text-text-muted">
          Hours above this in a single day get flagged for a closer look. This
          governs the <strong>legacy approvals</strong> bulk-approve guard and the
          rate-flag chip — the v2 &ldquo;Approve all&rdquo; does not read it
          (yet). Setting it here changes the legacy rule today.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <input
            id="hours-daily-threshold"
            data-testid="hours-daily-threshold"
            type="number"
            inputMode="decimal"
            min={1}
            max={24}
            step="0.5"
            value={value}
            disabled={!canEdit || saving}
            onChange={(e) => {
              setValue(e.target.value);
              setSavedAt(null);
            }}
            className="h-9 w-28 rounded-card border border-border bg-surface px-2 text-sm disabled:opacity-60"
          />
          <span className="text-sm text-text-muted">hours / day</span>
        </div>
        {!valid && value !== "" ? (
          <p className="mt-1 text-xs text-state-danger" data-testid="hours-policy-invalid">
            {check.ok ? "" : check.error}
          </p>
        ) : null}
      </div>

      {saveError ? (
        <p
          data-testid="hours-policy-save-error"
          role="alert"
          className="rounded-card border-l-2 border-l-state-danger bg-surface-raised px-3 py-2 text-sm text-text"
        >
          {saveError}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button
            data-testid="hours-policy-save"
            onClick={save}
            disabled={saving || !dirty || !valid}
          >
            {saving ? "Saving…" : "Save policy"}
          </Button>
          {savedAt ? <span className="text-xs text-state-success">Saved.</span> : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          Read-only — only office admins can change company policy.
        </p>
      )}

      {updatedLine ? (
        <p data-testid="hours-policy-updated" className="text-xs text-text-muted">
          {updatedLine}
        </p>
      ) : null}
    </div>
  );
}
