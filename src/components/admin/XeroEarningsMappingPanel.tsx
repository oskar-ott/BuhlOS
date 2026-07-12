"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * XeroEarningsMappingPanel (#611) — work type → Xero earnings rate.
 *
 * The vocabulary is the REAL hours model (ordinary + overtime today); a work
 * type never silently defaults to ordinary — unmapped is a named blocker the
 * payroll validation engine (#894) enforces. Suggestions (by Xero's own
 * EarningsType classification) never auto-apply: confirming is deliberate and
 * shows both sides.
 */

type BoardRow = {
  workType: string;
  label: string;
  mapping: {
    rateId: string;
    rateName: string | null;
    linkedByName: string | null;
    linkedAt: string;
    orgMismatch: boolean;
    rateMissingFromCache: boolean;
    rateInactive: boolean;
    typeMismatch: boolean;
    sharedWith: string[];
  } | null;
  suggestion: { rateId: string; rateName: string; reason: string } | null;
};

type Board = {
  organisationName: string | null;
  workTypes: BoardRow[];
  unmappedCount: number;
  rates: Array<{ xeroId: string; name: string; active: boolean; earningsType: string | null; rateType: string | null }>;
  rateCache: { count: number; lastSync: { at: string; status: string; errorCategory: string | null } | null; trustworthy: boolean };
};

const BTN = "rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy disabled:opacity-50";
const BTN_PRIMARY = "rounded-card bg-brand-navy px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const BTN_DANGER = "rounded-card border border-state-danger px-3 py-1.5 text-sm font-medium text-state-danger hover:bg-state-danger/5 disabled:opacity-50";
const CHIP_WARN = "ml-2 rounded-full border border-state-warning px-2 py-0.5 text-xs text-state-warning";
const CHIP_DANGER = "ml-2 rounded-full border border-state-danger px-2 py-0.5 text-xs text-state-danger";

export function XeroEarningsMappingPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_connected" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/xero/worktype-mappings", { cache: "no-store" });
      if (res.status === 409) {
        setState("not_connected");
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      setBoard((await res.json()) as Board);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmRate(workType: string, rateId: string) {
    setBusy(workType);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch("/api/xero/worktype-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "map", workType, rateId }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean; workTypeLabel?: string; rateName?: string; rateInactive?: boolean; typeMismatch?: boolean; error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error || "Couldn't confirm the mapping.");
        return;
      }
      setBanner(
        `Mapped ${data.workTypeLabel} → ${data.rateName}.` +
          (data.rateInactive ? " Note: this rate is inactive in Xero." : "") +
          (data.typeMismatch ? " Note: Xero classifies this rate as a different earnings type — double-check it." : "")
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function unmap(workType: string) {
    setBusy(workType);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch("/api/xero/worktype-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unmap", workType }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error || "Couldn't unmap.");
        return;
      }
      setBanner("Mapping removed.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (state === "loading") {
    return (
      <Card>
        <CardTitle>Work type → Xero earnings rate</CardTitle>
        <CardDescription className="mt-1">Loading the mapping board…</CardDescription>
      </Card>
    );
  }
  if (state === "not_connected") {
    return (
      <Card>
        <CardTitle>Work type → Xero earnings rate</CardTitle>
        <CardDescription className="mt-1">
          Once Xero is connected and pay items are imported, each kind of hours (ordinary,
          overtime) gets explicitly mapped to a Xero earnings rate here — a work type never
          silently defaults to ordinary.
        </CardDescription>
      </Card>
    );
  }
  if (state === "error" || !board) {
    return (
      <Card>
        <CardTitle>Work type → Xero earnings rate</CardTitle>
        <CardDescription className="mt-1">
          <span role="alert">Couldn&rsquo;t load the mapping board. Reload the page to retry.</span>
        </CardDescription>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Work type → Xero earnings rate</CardTitle>
      <CardDescription className="mt-1">
        What each kind of hours becomes in Xero. Confirmed by you, stored by Xero&rsquo;s
        permanent rate ID; an unmapped work type blocks payroll batching — never a silent
        default.
        {board.unmappedCount > 0 ? (
          <span className="mt-1 block font-medium text-state-warning" data-testid="xero-wt-unmapped-count">
            {board.unmappedCount} work type{board.unmappedCount === 1 ? "" : "s"} not mapped yet.
          </span>
        ) : (
          <span className="mt-1 block font-medium text-state-success">All work types are mapped.</span>
        )}
      </CardDescription>

      {!board.rateCache.trustworthy ? (
        <div className="mt-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
          {board.rateCache.lastSync
            ? `The last pay-items import from Xero FAILED (${board.rateCache.lastSync.errorCategory ?? "unknown"}) — refresh the reference data above and retry.`
            : "Pay items haven't been imported from Xero yet — refresh the reference data above first."}
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

      <ul className="mt-4 divide-y divide-border" data-testid="xero-wt-rows">
        {board.workTypes.map((row) => {
          const pick = picks[row.workType] ?? "";
          return (
            <li key={row.workType} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-text">{row.label}</p>
                <p className="text-xs text-text-muted">BuhlOS work type &ldquo;{row.workType}&rdquo;</p>
              </div>
              <div className="text-right">
                {row.mapping ? (
                  <>
                    <p className="text-sm text-text">
                      → <span className="font-medium">{row.mapping.rateName ?? row.mapping.rateId}</span>
                      {row.mapping.orgMismatch ? <span className={CHIP_DANGER}>mapped in a different Xero org</span> : null}
                      {row.mapping.rateMissingFromCache ? <span className={CHIP_DANGER}>rate no longer in Xero</span> : null}
                      {row.mapping.rateInactive ? <span className={CHIP_WARN}>inactive in Xero</span> : null}
                      {row.mapping.typeMismatch ? <span className={CHIP_WARN}>earnings-type mismatch</span> : null}
                      {row.mapping.sharedWith.length ? (
                        <span className={CHIP_WARN}>also used by {row.mapping.sharedWith.join(", ")}</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-text-muted">
                      mapped {new Date(row.mapping.linkedAt).toLocaleDateString()} by {row.mapping.linkedByName ?? "admin"}
                    </p>
                    <button className={`${BTN_DANGER} mt-1`} disabled={busy === row.workType} onClick={() => void unmap(row.workType)}>
                      Unmap
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col items-end gap-1">
                    {row.suggestion ? (
                      <button
                        className={BTN}
                        disabled={busy === row.workType}
                        onClick={() => void confirmRate(row.workType, row.suggestion!.rateId)}
                        data-testid={`xero-wt-suggest-${row.workType}`}
                      >
                        {busy === row.workType ? "Mapping…" : `Confirm suggestion: ${row.suggestion.rateName} (${row.suggestion.reason === "earnings_type" ? "Xero classifies it as this type" : "name matches"})`}
                      </button>
                    ) : null}
                    <div className="flex gap-2">
                      <select
                        className="rounded-card border border-border px-2 py-1.5 text-sm"
                        value={pick}
                        onChange={(e) => setPicks((p) => ({ ...p, [row.workType]: e.target.value }))}
                        aria-label={`Earnings rate for ${row.label}`}
                      >
                        <option value="">Choose earnings rate…</option>
                        {board.rates.map((r) => (
                          <option key={r.xeroId} value={r.xeroId}>
                            {r.name}
                            {r.earningsType ? ` · ${r.earningsType}` : ""}
                            {r.active ? "" : " · INACTIVE"}
                          </option>
                        ))}
                      </select>
                      <button
                        className={BTN_PRIMARY}
                        disabled={!pick || busy === row.workType}
                        onClick={() => void confirmRate(row.workType, pick)}
                      >
                        {busy === row.workType ? "Mapping…" : "Map"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
