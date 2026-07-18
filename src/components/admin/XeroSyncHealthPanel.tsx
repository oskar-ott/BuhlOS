"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import {
  headlineState,
  taxonomyFor,
  type OpenItem,
  type SyncHeadlineState,
  type XeroSyncType,
} from "@/domains/xero/sync-log";

/**
 * Xero sync health (#251, M5) — every exchange failure on one panel with a
 * retry that can only travel the original code path (the server's handler
 * registry), and acknowledge-with-a-required-note. Three honest headline
 * states: green means CONNECTED AND CLEAR — never just "nothing recorded";
 * an unreadable store renders as its own loud state, never empty-green.
 *
 * Data: /api/xero/status (connection) + /api/xero-sync-log (outcome store).
 * Presentational logic lives in <SyncHealthView/> so states render-test
 * without a DOM fetch.
 */

interface SyncState {
  items: OpenItem[];
  counts: { total: number; byType: Record<string, number> };
  lastSuccessAt: Record<string, string>;
}

type Load =
  | { kind: "loading" }
  | { kind: "unreadable"; message: string }
  | { kind: "ready"; headline: SyncHeadlineState; state: SyncState };

const TYPE_LABEL: Record<XeroSyncType, string> = {
  reference_sync: "Reference data",
  timesheet_export: "Timesheet export",
  reconciliation: "Reconciliation",
};

function shortWhen(iso: string | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(t));
}

export function XeroSyncHealthPanel() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, stateRes] = await Promise.all([
        fetch("/api/xero/status"),
        fetch("/api/xero-sync-log"),
      ]);
      if (!statusRes.ok || !stateRes.ok) {
        throw new Error(`sync log unreadable (${statusRes.status}/${stateRes.status})`);
      }
      const status = (await statusRes.json()) as { state?: string };
      const state = (await stateRes.json()) as SyncState;
      const connection =
        status.state === "not_configured"
          ? ("never" as const)
          : status.state === "disconnected"
            ? ("disconnected" as const)
            : ("connected" as const);
      setLoad({
        kind: "ready",
        headline: headlineState({ connection, openTotal: state.counts?.total ?? 0 }),
        state,
      });
    } catch (e) {
      setLoad({ kind: "unreadable", message: e instanceof Error ? e.message : "sync log unreadable" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(key: string, path: string, body: unknown) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(out?.error || `failed (${res.status})`);
      setAckFor(null);
      setAckNote("");
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SyncHealthView
      load={load}
      busy={busy}
      actionError={actionError}
      ackFor={ackFor}
      ackNote={ackNote}
      onAckOpen={(op) => {
        setAckFor(op);
        setAckNote("");
      }}
      onAckNote={setAckNote}
      onAck={(op) => void act(`ack:${op}`, "/api/xero-sync-log", { action: "acknowledge", operation: op, note: ackNote })}
      onRetry={(op) => void act(`retry:${op}`, "/api/xero-sync-log", { action: "retry", operation: op })}
      onRetryAll={() => void act("retry_all", "/api/xero-sync-log", { action: "retry_all" })}
    />
  );
}

// ── Pure view (render-tested) ───────────────────────────────────────────

export function SyncHealthView({
  load,
  busy,
  actionError,
  ackFor,
  ackNote,
  onAckOpen,
  onAckNote,
  onAck,
  onRetry,
  onRetryAll,
}: {
  load: Load;
  busy: string | null;
  actionError: string | null;
  ackFor: string | null;
  ackNote: string;
  onAckOpen: (operation: string) => void;
  onAckNote: (note: string) => void;
  onAck: (operation: string) => void;
  onRetry: (operation: string) => void;
  onRetryAll: () => void;
}) {
  return (
    <Card>
      <CardTitle>Xero sync health</CardTitle>
      <CardDescription className="mt-1">
        Every exchange with Xero, reconciled — failures stay here until they land or you close them with a note.
      </CardDescription>

      {load.kind === "loading" ? (
        <p className="mt-3 text-sm text-text-muted">Checking the sync log…</p>
      ) : null}

      {load.kind === "unreadable" ? (
        <p className="mt-3 rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
          Couldn&rsquo;t read the sync log ({load.message}) — this is NOT an all-clear. Refresh, and if it
          persists the log store itself needs attention.
        </p>
      ) : null}

      {load.kind === "ready" ? (
        <div className="mt-3 space-y-3">
          {load.headline === "never_connected" ? (
            <p className="text-sm text-text-muted">
              Xero has never been connected — connect it above, then sync outcomes will land here.
            </p>
          ) : load.headline === "disconnected" ? (
            <p className="rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
              Xero is disconnected — reconnect above. Outcomes below are from before the connection dropped.
            </p>
          ) : load.headline === "all_clear" ? (
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
              0 outstanding — connected, and every recorded exchange has landed.
            </p>
          ) : (
            <p className="text-sm font-medium text-amber-900">
              {load.state.counts.total} outstanding {load.state.counts.total === 1 ? "failure" : "failures"}
            </p>
          )}

          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
            {(Object.keys(TYPE_LABEL) as XeroSyncType[]).map((t) => (
              <div key={t} className="flex gap-1">
                <dt>{TYPE_LABEL[t]}:</dt>
                <dd>last success {shortWhen(load.state.lastSuccessAt?.[t])}</dd>
              </div>
            ))}
          </dl>

          {load.state.items.length > 0 ? (
            <>
              <ul className="space-y-2">
                {load.state.items.map((item) => {
                  const meta = item.category ? taxonomyFor(item.category) : null;
                  return (
                    <li key={item.operation} className="rounded-card border border-border bg-surface p-3">
                      <p className="text-sm font-medium text-text">
                        {meta?.operatorMessage ?? item.reason ?? "Sync failure"}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {TYPE_LABEL[item.syncType]} · {item.recordRef} · seen {item.seenCount}
                        {item.seenCount === 1 ? " time" : " times"} · last {shortWhen(item.lastSeenAt)}
                      </p>
                      {meta ? <p className="mt-1 text-xs text-text-muted">{meta.requiredAction}</p> : null}
                      {item.reason && meta ? (
                        <p className="mt-1 break-words font-mono text-[11px] text-text-muted">{item.reason}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => onRetry(item.operation)}
                          className="rounded-card border border-border bg-surface-subtle px-3 py-1.5 text-xs font-medium text-text"
                        >
                          {busy === `retry:${item.operation}` ? "Retrying…" : "Retry"}
                        </button>
                        {ackFor === item.operation ? (
                          <span className="flex flex-1 items-center gap-2">
                            <input
                              value={ackNote}
                              onChange={(e) => onAckNote(e.target.value)}
                              placeholder="Why is this closed? (required)"
                              className="h-8 min-w-40 flex-1 rounded-card border border-border bg-background px-2 text-xs text-text"
                            />
                            <button
                              type="button"
                              disabled={busy !== null || !ackNote.trim()}
                              onClick={() => onAck(item.operation)}
                              className="rounded-card border border-border bg-surface-subtle px-3 py-1.5 text-xs font-medium text-text"
                            >
                              {busy === `ack:${item.operation}` ? "Closing…" : "Close with note"}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => onAckOpen(item.operation)}
                            className="text-xs text-text-muted underline"
                          >
                            Acknowledge
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                disabled={busy !== null}
                onClick={onRetryAll}
                className="rounded-card border border-border bg-surface-subtle px-3 py-1.5 text-xs font-medium text-text"
              >
                {busy === "retry_all" ? "Retrying all…" : "Retry all"}
              </button>
            </>
          ) : null}

          {actionError ? (
            <p className="text-xs text-status-danger" role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
