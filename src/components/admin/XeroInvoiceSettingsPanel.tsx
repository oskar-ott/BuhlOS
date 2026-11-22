"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  errorCodeOf,
  invoiceSettings,
  invoiceSettingsOptions,
  saveInvoiceSettings,
} from "@/domains/customer-invoices/client";
import { errorMessage, formatBp, xeroBlocker } from "@/domains/customer-invoices/format";
import type {
  InvoiceSettingsOptions,
  InvoiceSettingsResponse,
} from "@/domains/customer-invoices/schema";

const SELECT =
  "mt-1 h-10 w-full rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60";
const LABEL = "block text-sm font-medium text-text";

/**
 * XeroInvoiceSettingsPanel (#1149, customer_invoices) — the three defaults a
 * customer stage invoice needs: which sales account its lines go to, which
 * tax rate applies, and how many days the client has to pay.
 *
 * The account and tax lists are read LIVE from the connected Xero
 * organisation each time the panel opens — BuhlOS keeps no copy of the chart
 * of accounts. On save the server re-reads both lists and stores Xero's own
 * names and rate, so nothing typed or stale can be saved.
 *
 * Nothing here sends anything to Xero; these are choices stored in BuhlOS for
 * the draft invoices #1150 will create.
 *
 * States, all honest: Xero not usable (which, and what fixes it) · options
 * loading · options unreadable (retry) · no revenue accounts / tax rates in
 * Xero · ready. Rendered only while customer_invoices is on for the viewer;
 * hides itself on a 403/404.
 */
export function XeroInvoiceSettingsPanel() {
  const [data, setData] = useState<InvoiceSettingsResponse | null>(null);
  const [options, setOptions] = useState<InvoiceSettingsOptions | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const loadOptions = useCallback(async () => {
    setOptionsError(null);
    const res = await invoiceSettingsOptions();
    if (res.ok) setOptions(res.data);
    else setOptionsError(errorMessage(errorCodeOf(res.error.body), res.error.status));
  }, []);

  const load = useCallback(async () => {
    const res = await invoiceSettings();
    if (!res.ok) {
      setState(res.error.status === 403 || res.error.status === 404 ? "hidden" : "error");
      return;
    }
    setData(res.data);
    setState("ready");
    if (res.data.xero.state === "connected") void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "hidden") return null;

  return (
    <Card data-testid="xero-invoice-settings">
      <CardTitle>Invoices</CardTitle>
      <CardDescription className="mt-1">
        The defaults BuhlOS will put on a job&rsquo;s stage invoices. Nothing is sent to Xero from
        here; these are only the choices.
      </CardDescription>
      <div className="mt-4">
        {state === "loading" ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : state === "error" || !data ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-text-muted" role="alert">
              Couldn&rsquo;t load the invoice settings.
            </p>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <InvoiceSettingsView
            data={data}
            options={options}
            optionsError={optionsError}
            onRetryOptions={loadOptions}
            onSaved={setData}
          />
        )}
      </div>
    </Card>
  );
}

/** The loaded panel body — a pure function of its props plus the form state. */
export function InvoiceSettingsView({
  data,
  options,
  optionsError,
  onRetryOptions,
  onSaved,
  save = saveInvoiceSettings,
}: {
  data: InvoiceSettingsResponse;
  options: InvoiceSettingsOptions | null;
  optionsError: string | null;
  onRetryOptions: () => Promise<void> | void;
  onSaved: (next: InvoiceSettingsResponse) => void;
  /** Injectable for tests. */
  save?: typeof saveInvoiceSettings;
}) {
  const s = data.settings;
  const [account, setAccount] = useState(s?.salesAccountCode ?? "");
  const [tax, setTax] = useState(s?.taxType ?? "");
  const [terms, setTerms] = useState(s?.paymentTermsDays == null ? "" : String(s.paymentTermsDays));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const blocker = xeroBlocker(data.xero.state);
  if (blocker) {
    return (
      <div data-testid="xero-invoice-settings-blocked">
        {s ? <SavedSummary data={data} /> : null}
        <p className="text-sm text-text">{blocker.message}</p>
        {data.xero.state === "missing_permission" || data.xero.state === "reconnect_required" ? (
          <a
            href="/api/xero/connect"
            className="mt-2 inline-flex h-10 items-center rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse"
          >
            {blocker.action}
          </a>
        ) : (
          <p className="mt-1 text-sm text-text-muted">Connect Xero in the panel above first.</p>
        )}
      </div>
    );
  }

  if (optionsError) {
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="xero-invoice-options-error">
        <p className="text-sm text-text-muted" role="alert">
          Couldn&rsquo;t read the accounts and tax rates from Xero. {optionsError}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void onRetryOptions()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!options) {
    return <p className="text-sm text-text-muted">Reading your accounts and tax rates from Xero…</p>;
  }
  if (options.accounts.length === 0 || options.taxRates.length === 0) {
    return (
      <p className="text-sm text-text" data-testid="xero-invoice-options-empty">
        {options.accounts.length === 0
          ? "Xero has no active revenue account with a code. Add one in Xero's chart of accounts, then come back."
          : "Xero has no active tax rate that can be used on sales. Add one in Xero, then come back."}
      </p>
    );
  }

  // A saved choice that Xero no longer offers must be visible, not silently
  // swapped for the first option.
  const accountGone = !!account && !options.accounts.some((a) => a.code === account);
  const taxGone = !!tax && !options.taxRates.some((t) => t.taxType === tax);

  async function submit() {
    const days = Number(terms);
    if (!account || accountGone) return setProblem("Choose the sales account.");
    if (!tax || taxGone) return setProblem("Choose the tax rate.");
    if (terms.trim() === "" || !Number.isInteger(days) || days < 0 || days > 365) {
      return setProblem("Enter the payment terms as a whole number of days, from 0 to 365.");
    }
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const res = await save({
      salesAccountCode: account,
      taxType: tax,
      paymentTermsDays: days,
      expectedVersion: s?.version ?? null,
    });
    setBusy(false);
    if (res.ok) {
      onSaved(res.data);
      setSaved(true);
      return;
    }
    const code = errorCodeOf(res.error.body);
    setProblem(errorMessage(code, res.error.status));
    if (code === "account_not_in_xero" || code === "tax_rate_not_in_xero") void onRetryOptions();
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid="xero-invoice-settings-form"
    >
      {data.xero.organisationName ? (
        <p className="text-xs text-text-muted">
          Lists read live from <span className="font-medium text-text">{data.xero.organisationName}</span>.
        </p>
      ) : null}

      <div>
        <label htmlFor="inv-account" className={LABEL}>
          Sales account
        </label>
        <select
          id="inv-account"
          className={SELECT}
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setProblem(null);
            setSaved(false);
          }}
          disabled={busy}
        >
          <option value="">Choose an account…</option>
          {accountGone ? (
            <option value={account}>
              {account} — {s?.salesAccountName ?? "saved account"} (no longer active in Xero)
            </option>
          ) : null}
          {options.accounts.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-text-muted">Every stage invoice line is coded to this account.</p>
      </div>

      <div>
        <label htmlFor="inv-tax" className={LABEL}>
          Tax rate
        </label>
        <select
          id="inv-tax"
          className={SELECT}
          value={tax}
          onChange={(e) => {
            setTax(e.target.value);
            setProblem(null);
            setSaved(false);
          }}
          disabled={busy}
        >
          <option value="">Choose a tax rate…</option>
          {taxGone ? (
            <option value={tax}>{s?.taxName ?? tax} (no longer active in Xero)</option>
          ) : null}
          {options.taxRates.map((t) => (
            <option key={t.taxType} value={t.taxType}>
              {t.name} ({formatBp(t.rateBp)})
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-text-muted">
          Stage amounts in BuhlOS are ex GST; Xero adds the tax from this rate.
        </p>
      </div>

      <div>
        <label htmlFor="inv-terms" className={LABEL}>
          Payment terms (days)
        </label>
        <input
          id="inv-terms"
          inputMode="numeric"
          className="mt-1 h-10 w-28 rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60"
          value={terms}
          onChange={(e) => {
            setTerms(e.target.value);
            setProblem(null);
            setSaved(false);
          }}
          placeholder="30"
          disabled={busy}
        />
        <p className="mt-1 text-xs text-text-muted">
          The due date on an invoice is its date plus this many days.
        </p>
      </div>

      {problem ? (
        <p className="text-sm text-state-danger-subtle-text" role="alert" data-testid="xero-invoice-settings-problem">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save invoice defaults"}
        </Button>
        {saved ? (
          <span className="text-sm text-state-success-subtle-text" role="status">
            Saved.
          </span>
        ) : !data.complete ? (
          <span className="text-sm text-text-muted">Not chosen yet.</span>
        ) : null}
      </div>
    </form>
  );
}

function SavedSummary({ data }: { data: InvoiceSettingsResponse }) {
  const s = data.settings;
  if (!s) return null;
  return (
    <p className="mb-2 text-sm text-text-muted">
      Saved: {s.salesAccountCode} — {s.salesAccountName} · {s.taxName} ({formatBp(s.taxRateBp)}) ·{" "}
      {s.paymentTermsDays} days.
    </p>
  );
}
