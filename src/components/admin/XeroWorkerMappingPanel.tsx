"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * XeroWorkerMappingPanel (#248) — explicit worker ↔ Xero employee links.
 *
 * One wrong link is someone else's pay, so confirmation is DELIBERATE: the
 * confirm step always shows BOTH sides' name + email before the link is
 * written, suggestions never auto-apply, and a 1:1 conflict names the
 * existing holder. Unmapped workers are the headline — they are exactly the
 * blockers the timesheet push (#249) will name.
 */

type BoardWorker = {
  workerId: string;
  workerName: string;
  workerEmail: string | null;
  disabled: boolean;
  mapping: {
    employeeId: string;
    employeeName: string | null;
    statusSnapshot: string | null;
    linkedByName: string | null;
    linkedAt: string;
    source: string;
    orgMismatch: boolean;
    employeeMissingFromCache: boolean;
    employeeInactive: boolean;
  } | null;
  suggestion: { employeeId: string; employeeName: string; reason: "email" | "legacy_id" | "name" } | null;
  invalidLegacyId: string | null;
  legacyConflictWith: string[];
};

type Board = {
  organisationName: string | null;
  workers: BoardWorker[];
  unmappedCount: number;
  employees: Array<{ xeroId: string; name: string; active: boolean; email: string | null; status: string | null }>;
  employeeCache: {
    count: number;
    lastSync: { at: string; status: string; errorCategory: string | null } | null;
    trustworthy: boolean;
  };
};

const REASON_COPY: Record<string, string> = {
  email: "email matches",
  legacy_id: "matches the previously hand-typed Xero ID",
  name: "name matches",
};

const BTN = "rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy disabled:opacity-50";
const BTN_PRIMARY = "rounded-card bg-brand-navy px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const BTN_DANGER = "rounded-card border border-state-danger px-3 py-1.5 text-sm font-medium text-state-danger hover:bg-state-danger/5 disabled:opacity-50";
const CHIP_WARN = "ml-2 rounded-full border border-state-warning px-2 py-0.5 text-xs text-state-warning";
const CHIP_DANGER = "ml-2 rounded-full border border-state-danger px-2 py-0.5 text-xs text-state-danger";

export function XeroWorkerMappingPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_connected" | "error">("loading");
  const [busyWorker, setBusyWorker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // workerId → employeeId chosen in the picker (pre-confirm)
  const [picks, setPicks] = useState<Record<string, string>>({});
  // workerId whose confirm summary is showing (the deliberate step)
  const [confirming, setConfirming] = useState<{ workerId: string; employeeId: string; source: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/xero/worker-mappings", { cache: "no-store" });
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

  async function confirmLink(workerId: string, employeeId: string, source: string) {
    setBusyWorker(workerId);
    setError(null);
    setBanner(null);
    try {
      const res = await fetch("/api/xero/worker-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "map", workerId, employeeId, source }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        workerName?: string;
        employeeName?: string;
        employeeInactive?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error || "Couldn't confirm the link.");
        return;
      }
      setBanner(
        `Linked ${data.workerName} → ${data.employeeName}.${data.employeeInactive ? " Note: this employee is inactive in Xero." : ""}`
      );
      setConfirming(null);
      await load();
    } finally {
      setBusyWorker(null);
    }
  }

  async function unlink(workerId: string) {
    setBusyWorker(workerId);
    setError(null);
    setBanner(null);
    try {
      const res = await fetch("/api/xero/worker-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unmap", workerId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error || "Couldn't unlink.");
        return;
      }
      setBanner("Link removed.");
      await load();
    } finally {
      setBusyWorker(null);
    }
  }

  if (state === "loading") {
    return (
      <Card>
        <CardTitle>Worker → Xero employee links</CardTitle>
        <CardDescription className="mt-1">Loading the mapping board…</CardDescription>
      </Card>
    );
  }
  if (state === "not_connected") {
    return (
      <Card>
        <CardTitle>Worker → Xero employee links</CardTitle>
        <CardDescription className="mt-1" data-testid="xero-map-disconnected">
          Once Xero is connected and employees are imported, each hours-tracked worker gets
          explicitly linked to their Xero employee here — links are confirmed by you, never
          guessed, so hours can never land on the wrong payslip.
        </CardDescription>
      </Card>
    );
  }
  if (state === "error" || !board) {
    return (
      <Card>
        <CardTitle>Worker → Xero employee links</CardTitle>
        <CardDescription className="mt-1">
          <span role="alert">Couldn&rsquo;t load the mapping board. Reload the page to retry.</span>
        </CardDescription>
      </Card>
    );
  }

  const employeeById = new Map(board.employees.map((e) => [e.xeroId, e]));

  return (
    <Card>
      <CardTitle>Worker → Xero employee links</CardTitle>
      <CardDescription className="mt-1">
        Every link is confirmed by you and stored by Xero&rsquo;s permanent employee ID — never
        guessed from names. Unmapped workers can&rsquo;t be included in a payroll push; they&rsquo;re
        named, never silently skipped.
        {board.unmappedCount > 0 ? (
          <span className="mt-1 block font-medium text-state-warning" data-testid="xero-map-unmapped-count">
            {board.unmappedCount} worker{board.unmappedCount === 1 ? "" : "s"} not linked yet.
          </span>
        ) : (
          <span className="mt-1 block font-medium text-state-success">All tracked workers are linked.</span>
        )}
      </CardDescription>

      {!board.employeeCache.trustworthy ? (
        <div className="mt-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert" data-testid="xero-map-cache-error">
          {board.employeeCache.lastSync
            ? `The last employee import from Xero FAILED (${board.employeeCache.lastSync.errorCategory ?? "unknown"}) — this list may be incomplete. Refresh the reference data above and retry.`
            : "Employees haven't been imported from Xero yet — refresh the reference data above first."}
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

      <ul className="mt-4 divide-y divide-border" data-testid="xero-map-rows">
        {board.workers.map((w) => {
          const pick = picks[w.workerId] ?? "";
          const pending = confirming?.workerId === w.workerId ? confirming : null;
          const pendingEmployee = pending ? employeeById.get(pending.employeeId) : null;
          return (
            <li key={w.workerId} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">
                    {w.workerName}
                    {w.disabled ? <span className={CHIP_WARN}>disabled — link kept for final pay</span> : null}
                  </p>
                  <p className="text-xs text-text-muted">{w.workerEmail ?? "no email on file"}</p>
                  {w.invalidLegacyId ? (
                    <p className="mt-1 text-xs text-state-warning" data-testid={`xero-map-invalid-legacy-${w.workerId}`}>
                      Previously typed Xero ID &ldquo;{w.invalidLegacyId}&rdquo; matches no current employee — pick the right one below.
                    </p>
                  ) : null}
                  {w.legacyConflictWith.length ? (
                    <p className="mt-1 text-xs text-state-danger">
                      The same hand-typed Xero ID also appears on {w.legacyConflictWith.join(", ")} — resolve deliberately.
                    </p>
                  ) : null}
                </div>

                <div className="min-w-0 text-right">
                  {w.mapping ? (
                    <>
                      <p className="text-sm text-text">
                        → <span className="font-medium">{w.mapping.employeeName ?? w.mapping.employeeId}</span>
                        {w.mapping.orgMismatch ? <span className={CHIP_DANGER}>linked in a different Xero org</span> : null}
                        {w.mapping.employeeMissingFromCache ? <span className={CHIP_DANGER}>no longer in Xero</span> : null}
                        {w.mapping.employeeInactive ? <span className={CHIP_WARN}>inactive in Xero</span> : null}
                      </p>
                      <p className="text-xs text-text-muted">
                        linked {new Date(w.mapping.linkedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })} by {w.mapping.linkedByName ?? "admin"}
                      </p>
                      <button
                        className={`${BTN_DANGER} mt-1`}
                        disabled={busyWorker === w.workerId}
                        onClick={() => void unlink(w.workerId)}
                        data-testid={`xero-map-unlink-${w.workerId}`}
                      >
                        Unlink
                      </button>
                    </>
                  ) : pending && pendingEmployee ? (
                    <div className="rounded-card border-2 border-brand-navy px-3 py-2 text-left" data-testid={`xero-map-confirm-${w.workerId}`}>
                      <p className="text-xs text-text">
                        Link <span className="font-medium">{w.workerName}</span> ({w.workerEmail ?? "no email"})
                        <br />→ <span className="font-medium">{pendingEmployee.name}</span> ({pendingEmployee.email ?? "no email"}
                        {pendingEmployee.status ? ` · ${pendingEmployee.status}` : ""})?
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          className={BTN_PRIMARY}
                          disabled={busyWorker === w.workerId}
                          onClick={() => void confirmLink(pending.workerId, pending.employeeId, pending.source)}
                        >
                          {busyWorker === w.workerId ? "Linking…" : "Confirm link"}
                        </button>
                        <button className={BTN} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      {w.suggestion ? (
                        <button
                          className={BTN}
                          onClick={() =>
                            setConfirming({
                              workerId: w.workerId,
                              employeeId: w.suggestion!.employeeId,
                              source: w.suggestion!.reason === "email" ? "email_suggestion" : w.suggestion!.reason === "name" ? "name_suggestion" : "legacy_import",
                            })
                          }
                          data-testid={`xero-map-suggest-${w.workerId}`}
                        >
                          Suggested: {w.suggestion.employeeName} ({REASON_COPY[w.suggestion.reason]}) — review
                        </button>
                      ) : null}
                      <div className="flex gap-2">
                        <select
                          className="rounded-card border border-border px-2 py-1.5 text-sm"
                          value={pick}
                          onChange={(e) => setPicks((p) => ({ ...p, [w.workerId]: e.target.value }))}
                          aria-label={`Xero employee for ${w.workerName}`}
                        >
                          <option value="">Choose Xero employee…</option>
                          {board.employees.map((e) => (
                            <option key={e.xeroId} value={e.xeroId}>
                              {e.name}
                              {e.email ? ` · ${e.email}` : ""}
                              {e.active ? "" : " · INACTIVE"}
                            </option>
                          ))}
                        </select>
                        <button
                          className={BTN}
                          disabled={!pick}
                          onClick={() => setConfirming({ workerId: w.workerId, employeeId: pick, source: "manual" })}
                        >
                          Review link
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
