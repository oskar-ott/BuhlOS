"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * XeroReferenceDataPanel (#610) — the read-only payroll reference cache.
 *
 * Renders per-group counts (employees, payroll calendars, earnings rates,
 * leave types, other pay items, tracking categories), the last sync outcome,
 * honest staleness, and one "Refresh from Xero" action. Rendered on
 * /settings/integrations/xero below the connection panel.
 *
 * Honesty rules (P7/P8): a failed fetch is a loud per-group error with the
 * previous cache intact — never an empty list that reads as "the org has no
 * employees"; a never-synced or old cache is visibly stale; a pre-#610 grant
 * without the read scopes says "reconnect", not a mystery 403. When Xero is
 * not connected this panel says so quietly (the connection panel above owns
 * that state's actions).
 */

type GroupSummary = {
  group: "employees" | "calendars" | "pay_items" | "tracking_categories";
  kinds: Array<{ kind: string; count: number }>;
  lastSync: {
    at: string;
    status: "ok" | "failed";
    itemCount: number | null;
    errorCategory: string | null;
    correlationId: string | null;
  } | null;
  stale: boolean;
};

type Summary = {
  staleAfterDays: number;
  groups: GroupSummary[];
  scopesOk: boolean;
  organisationName: string | null;
};

const GROUP_LABELS: Record<GroupSummary["group"], string> = {
  employees: "Employees",
  calendars: "Payroll calendars",
  pay_items: "Pay items",
  tracking_categories: "Tracking categories",
};

const KIND_LABELS: Record<string, string> = {
  employee: "employees",
  payroll_calendar: "calendars",
  earnings_rate: "earnings rates",
  leave_type: "leave types",
  deduction_type: "deduction types",
  reimbursement_type: "reimbursement types",
  tracking_category: "categories",
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

const BTN_PRIMARY =
  "rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";

export function XeroReferenceDataPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_connected" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/xero/reference", { cache: "no-store" });
      if (res.status === 409) {
        setState("not_connected");
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      setSummary((await res.json()) as Summary);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch("/api/xero/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        results?: Array<{ group: string; status: string; itemCount?: number; errorCategory?: string }>;
        summary?: Summary | null;
        errorCategory?: string;
      } | null;
      if (!res.ok || !data?.results) {
        setError(
          data?.errorCategory
            ? `Refresh couldn't start (${data.errorCategory}).`
            : "Refresh couldn't start. Try again."
        );
        return;
      }
      const failed = data.results.filter((r) => r.status === "failed");
      if (failed.length === 0) {
        setBanner("Reference data refreshed from Xero.");
      } else {
        setError(
          `Refresh partially failed — ${failed
            .map((f) => `${GROUP_LABELS[f.group as GroupSummary["group"]] ?? f.group}: ${f.errorCategory}`)
            .join("; ")}. The previous data for those sections is kept. Retry when ready.`
        );
      }
      await load();
    } catch {
      setError("Refresh failed to run. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  if (state === "loading") {
    return (
      <Card>
        <CardTitle>Xero payroll reference data</CardTitle>
        <CardDescription className="mt-1">Loading the reference cache…</CardDescription>
      </Card>
    );
  }

  if (state === "not_connected") {
    return (
      <Card>
        <CardTitle>Xero payroll reference data</CardTitle>
        <CardDescription className="mt-1" data-testid="xero-ref-disconnected">
          Once Xero is connected, BuhlOS can read the organisation&rsquo;s payroll setup —
          employees, pay calendars, earnings rates and leave types — so worker and work-type
          mappings are checked against what really exists in Xero. Connect above to start.
        </CardDescription>
      </Card>
    );
  }

  if (state === "error" || !summary) {
    return (
      <Card>
        <CardTitle>Xero payroll reference data</CardTitle>
        <CardDescription className="mt-1">
          <span role="alert">Couldn&rsquo;t load the reference cache. Reload the page to retry.</span>
        </CardDescription>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Xero payroll reference data</CardTitle>
          <CardDescription className="mt-1">
            Read-only snapshot of {summary.organisationName ?? "the connected organisation"}&rsquo;s
            payroll setup, used to validate mappings. Xero stays the source of truth — this cache
            is never edited here and nothing is written back to Xero.
          </CardDescription>
        </div>
        <button
          className={BTN_PRIMARY}
          disabled={refreshing || !summary.scopesOk}
          onClick={() => void refresh()}
          data-testid="xero-ref-refresh"
        >
          {refreshing ? "Refreshing…" : "Refresh from Xero"}
        </button>
      </div>

      {!summary.scopesOk ? (
        <div
          className="mt-3 rounded-card border border-state-warning px-3 py-2 text-sm text-state-warning"
          data-testid="xero-ref-scopes"
        >
          This Xero connection was made before payroll read access existed. Reconnect Xero (above)
          to grant read-only payroll permissions — nothing can be fetched until then.
        </div>
      ) : null}

      {banner ? (
        <div className="mt-3 rounded-card border border-state-success px-3 py-2 text-sm text-state-success" role="status">
          {banner}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
          {error}
        </div>
      ) : null}

      <ul className="mt-4 divide-y divide-border" data-testid="xero-ref-groups">
        {summary.groups.map((g) => {
          const total = g.kinds.reduce((n, k) => n + k.count, 0);
          const breakdown =
            g.kinds.length > 1
              ? g.kinds.map((k) => `${k.count} ${KIND_LABELS[k.kind] ?? k.kind}`).join(" · ")
              : null;
          return (
            <li key={g.group} className="flex items-start justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-text">
                  {GROUP_LABELS[g.group]}
                  {g.stale ? (
                    <span className="ml-2 rounded-full border border-state-warning px-2 py-0.5 text-xs text-state-warning">
                      {g.lastSync ? "stale" : "never synced"}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {g.lastSync
                    ? g.lastSync.status === "ok"
                      ? `Last synced ${fmtTime(g.lastSync.at)}`
                      : `Last refresh FAILED ${fmtTime(g.lastSync.at)} (${g.lastSync.errorCategory ?? "unknown"}) — showing the previous data`
                    : `Not fetched yet — refresh to import (older than ${summary.staleAfterDays} days counts as stale)`}
                  {breakdown ? ` · ${breakdown}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-text" data-testid={`xero-ref-count-${g.group}`}>
                {g.lastSync ? total : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
