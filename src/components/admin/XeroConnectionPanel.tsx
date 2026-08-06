"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * XeroConnectionPanel (#247) — the connection lifecycle surface.
 *
 * Renders the honest health state from GET /api/xero/status and drives the
 * four admin actions: Connect (browser navigates to /api/xero/connect →
 * Xero), Check connection, explicit organisation selection (when a grant
 * reaches more than one org), and Disconnect (explicit confirm). No token or
 * secret ever reaches this component — the status payload is a strict
 * server-side allow-list.
 */

type Health = {
  state:
    | "not_configured"
    | "disconnected"
    | "connecting"
    | "connected"
    | "degraded"
    | "refresh_failed"
    | "reconnect_required";
  organisationName?: string | null;
  externalTenantId?: string | null;
  grantedScopes?: string | null;
  connectedAt?: string | null;
  lastSuccessAt?: string | null;
  lastRefreshAttemptAt?: string | null;
  errorCategory?: string | null;
  config?: Record<string, boolean> | null;
  lastCheck?: { ok: boolean; errorCategory?: string };
};

type Organisation = { tenantId: string; tenantName: string };

const RESULT_COPY: Record<string, string> = {
  connected: "Xero is connected.",
  select_organisation: "Xero authorised — choose which organisation to connect below.",
};

function errorCopy(code: string): string {
  if (code === "consent_denied") return "Connection cancelled in Xero — nothing was changed.";
  if (code === "invalid_state") return "The connect link expired or didn't match this login. Start again from this page.";
  if (code === "no_organisations") return "Xero authorised, but this login can't access any organisation.";
  if (code === "persistence") return "Xero authorised but BuhlOS couldn't store the connection. Nothing was saved — try again.";
  if (code === "not_configured") return "Xero isn't configured in this environment.";
  return `The connection attempt failed (${code}). Nothing was changed.`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

const BTN = "rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy disabled:opacity-50";
const BTN_PRIMARY = "rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const BTN_DANGER = "rounded-card border border-state-danger px-3 py-2 text-sm font-medium text-state-danger hover:bg-state-danger/5 disabled:opacity-50";

export function XeroConnectionPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [organisations, setOrganisations] = useState<Organisation[] | null>(null);
  const [chosenOrg, setChosenOrg] = useState<string>("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/xero/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as Health;
      setHealth(data);
      setError(null);
      return data;
    } catch {
      setError("Couldn't load the Xero connection state. Reload to retry.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrganisations = useCallback(async () => {
    try {
      const res = await fetch("/api/xero/organisations", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { errorCategory?: string } | null;
        setError(
          `Couldn't list the authorised organisations${body?.errorCategory ? ` (${body.errorCategory})` : ""}. Reload to retry.`
        );
        return;
      }
      const data = (await res.json()) as { organisations: Organisation[] };
      setOrganisations(data.organisations);
    } catch {
      setError("Couldn't list the authorised organisations. Reload to retry.");
    }
  }, []);

  useEffect(() => {
    // One-shot result banner from the OAuth redirect, then clean the URL so a
    // reload doesn't replay it.
    const params = new URLSearchParams(window.location.search);
    const result = params.get("xero_result");
    const err = params.get("xero_error");
    if (result && RESULT_COPY[result]) setBanner(RESULT_COPY[result]);
    if (err) setError(errorCopy(err));
    if (result || err) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    void loadHealth().then((h) => {
      if (h?.state === "connecting") void loadOrganisations();
    });
  }, [loadHealth, loadOrganisations]);

  async function runCheck() {
    setBusy("check");
    try {
      const res = await fetch("/api/xero/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as Health;
      setHealth(data);
      setBanner(data.lastCheck?.ok ? "Connection check passed." : null);
      setError(data.lastCheck?.ok ? null : `Connection check failed (${data.lastCheck?.errorCategory ?? "unknown"}).`);
    } catch {
      setError("Connection check couldn't run. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function selectOrganisation() {
    if (!chosenOrg) return;
    setBusy("select");
    try {
      const res = await fetch("/api/xero/organisations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: chosenOrg }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; organisationName?: string; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ? `Couldn't select the organisation: ${data.error}` : "Couldn't select the organisation.");
        return;
      }
      setBanner(`Connected to ${data.organisationName}.`);
      setError(null);
      setOrganisations(null);
      await loadHealth();
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      const res = await fetch("/api/xero/disconnect", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; revokedAtProvider?: boolean } | null;
      if (!res.ok || !data?.ok) {
        setError("Disconnect failed. Try again.");
        return;
      }
      setBanner(
        data.revokedAtProvider
          ? "Disconnected — the grant was revoked at Xero."
          : "Disconnected locally. Xero couldn't be reached to revoke the grant — you can also remove BuhlOS under Xero's connected apps."
      );
      setError(null);
      setConfirmDisconnect(false);
      setOrganisations(null);
      await loadHealth();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardTitle>Xero</CardTitle>
        <CardDescription className="mt-1">Loading the connection state…</CardDescription>
      </Card>
    );
  }

  const state = health?.state ?? "disconnected";

  return (
    <div className="space-y-4">
      {banner ? (
        <div className="rounded-card border border-state-success px-3 py-2 text-sm text-state-success" role="status">
          {banner}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
          {error}
        </div>
      ) : null}

      <Card>
        <CardTitle>Xero</CardTitle>

        {state === "not_configured" ? (
          <CardDescription className="mt-1" data-testid="xero-not-configured">
            Xero isn&rsquo;t configured in this environment. An administrator needs to set the
            Xero app credentials and encryption key in the server environment (see issue #897) —
            no connection can start until then.
            {health?.config ? (
              <span className="mt-2 block text-xs">
                Present: {Object.entries(health.config).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`).join(" · ")}
              </span>
            ) : null}
          </CardDescription>
        ) : null}

        {state === "disconnected" ? (
          <>
            <CardDescription className="mt-1">
              Xero is not connected. Connecting lets BuhlOS import payroll settings later —
              nothing is sent to Xero by connecting, and the CSV export keeps working either way.
            </CardDescription>
            <div className="mt-3">
              <a href="/api/xero/connect" className={BTN_PRIMARY} data-testid="xero-connect">
                Connect Xero
              </a>
            </div>
          </>
        ) : null}

        {state === "connecting" ? (
          <>
            <CardDescription className="mt-1">
              Xero authorised — pick which organisation BuhlOS connects to. Nothing syncs until
              you confirm.
            </CardDescription>
            {organisations === null ? (
              <p className="mt-2 text-sm text-text-muted">Loading organisations…</p>
            ) : (
              <div className="mt-3 space-y-2" data-testid="xero-org-selection">
                {organisations.map((o) => (
                  <label key={o.tenantId} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="xero-org"
                      value={o.tenantId}
                      checked={chosenOrg === o.tenantId}
                      onChange={() => setChosenOrg(o.tenantId)}
                    />
                    {o.tenantName}
                  </label>
                ))}
                <div className="flex gap-2 pt-1">
                  <button className={BTN_PRIMARY} disabled={!chosenOrg || busy === "select"} onClick={() => void selectOrganisation()}>
                    {busy === "select" ? "Connecting…" : "Connect this organisation"}
                  </button>
                  <button className={BTN_DANGER} disabled={busy === "disconnect"} onClick={() => void disconnect()}>
                    Cancel and remove authorisation
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}

        {state === "connected" || state === "degraded" || state === "refresh_failed" ? (
          <>
            <CardDescription className="mt-1" data-testid="xero-connected">
              Connected to <span className="font-medium">{health?.organisationName ?? "(organisation)"}</span>
              <span className="mt-1 block">
                Status:{" "}
                {state === "connected"
                  ? "Healthy"
                  : `Degraded — the last refresh or check failed (${health?.errorCategory ?? "unknown"}); it retries automatically`}
              </span>
              <span className="mt-1 block text-xs">
                Connected {fmtTime(health?.connectedAt)} · last successful call {fmtTime(health?.lastSuccessAt)}
              </span>
            </CardDescription>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={BTN} disabled={busy === "check"} onClick={() => void runCheck()} data-testid="xero-check">
                {busy === "check" ? "Checking…" : "Check connection"}
              </button>
              {confirmDisconnect ? (
                <>
                  <button className={BTN_DANGER} disabled={busy === "disconnect"} onClick={() => void disconnect()} data-testid="xero-disconnect-confirm">
                    {busy === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                  <button className={BTN} onClick={() => setConfirmDisconnect(false)}>
                    Keep connected
                  </button>
                </>
              ) : (
                <button className={BTN_DANGER} onClick={() => setConfirmDisconnect(true)} data-testid="xero-disconnect">
                  Disconnect
                </button>
              )}
            </div>
          </>
        ) : null}

        {state === "reconnect_required" ? (
          <>
            <CardDescription className="mt-1" data-testid="xero-reconnect">
              Xero connection needs attention: the connection has expired or permission was
              revoked. Reconnecting starts a fresh Xero authorisation.
            </CardDescription>
            <div className="mt-3 flex gap-2">
              <a href="/api/xero/connect" className={BTN_PRIMARY}>
                Reconnect Xero
              </a>
              <button className={BTN_DANGER} disabled={busy === "disconnect"} onClick={() => void disconnect()}>
                Remove connection
              </button>
            </div>
          </>
        ) : null}
      </Card>

      <Card>
        <CardTitle>What connecting does — and doesn&rsquo;t</CardTitle>
        <CardDescription className="mt-1">
          This is the connection foundation only (#247). No hours, employees or payroll data move
          in either direction yet — reference import (#610), employee mapping (#248) and the draft
          timesheet push (#249) are separate, later steps with their own switches. The approved-hours
          CSV export keeps working unchanged as the permanent fallback.
        </CardDescription>
      </Card>
    </div>
  );
}
