"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  errorCodeOf,
  linkXeroContact,
  searchXeroContacts,
  unlinkXeroContact,
} from "@/domains/customer-invoices/client";
import {
  XERO_SETTINGS_PATH,
  errorMessage,
  xeroBlocker,
} from "@/domains/customer-invoices/format";
import type {
  JobInvoicingResponse,
  XeroContact,
} from "@/domains/customer-invoices/schema";
import type { HttpResult } from "@/lib/http";

const LINK =
  "font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2";

type Mutation = Promise<HttpResult<JobInvoicingResponse>>;

/**
 * "Client in Xero" on the Getting paid card (#1149). The job's client is
 * linked to a Xero contact by a PERSON — picked from a live search of the
 * connected organisation — never guessed from the name (ADR rule 8). When
 * another job with the same client name already has a link, that contact is
 * offered as a one-tap suggestion; it is still the person who applies it.
 *
 * When Xero can't be used (not connected, no invoice permission, …) the line
 * says which and links to the one place that fixes it. The schedule above
 * keeps working either way.
 */
export function XeroClientLine({
  data,
  run,
}: {
  data: JobInvoicingResponse;
  run: (call: () => Mutation) => Promise<boolean>;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = data.xero;
  const blocker = xeroBlocker(x.state);

  async function link(contact: XeroContact) {
    setBusy(true);
    const ok = await run(() => linkXeroContact(data.jobId, contact.id, data.profile.version));
    setBusy(false);
    // Close either way: on a failure the reason is shown on the card, which
    // the picker would otherwise be covering.
    setPicking(false);
    return ok;
  }

  async function unlink() {
    if (data.profile.version == null) return;
    const v = data.profile.version;
    setBusy(true);
    await run(() => unlinkXeroContact(data.jobId, v));
    setBusy(false);
  }

  if (blocker) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-xero-blocked">
        <span>
          {x.client.linked ? `Client in Xero: ${x.client.name}. ` : ""}
          {blocker.message}
        </span>
        <a href={XERO_SETTINGS_PATH} className={LINK}>
          {blocker.action}
        </a>
      </p>
    );
  }

  return (
    <>
      <div className="grid gap-1" data-testid="gp-xero-client">
        {x.client.linked ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted">
            <span>
              Client in Xero: <span className="font-medium text-text">{x.client.name}</span>
              {/* Name the organisation only when the link really is in it. */}
              {x.organisationName && !x.client.otherOrganisation ? ` (${x.organisationName})` : ""}.
            </span>
            <button type="button" className={LINK} onClick={() => setPicking(true)} disabled={busy}>
              Change
            </button>
            <button type="button" className={LINK} onClick={() => void unlink()} disabled={busy}>
              Remove link
            </button>
          </p>
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted">
            <span>
              Client in Xero: not linked
              {data.job.clientName ? ` (this job's client is ${data.job.clientName})` : ""}.
            </span>
            <button
              type="button"
              className={LINK}
              onClick={() => setPicking(true)}
              disabled={busy}
              data-testid="gp-link-client"
            >
              Link client
            </button>
          </p>
        )}

        {x.client.otherOrganisation ? (
          <p className="text-state-warning-subtle-text" data-testid="gp-client-other-org">
            This link was made while a different Xero organisation was connected. Link the client
            again so invoices go to the right contact
            {x.organisationName ? ` in ${x.organisationName}` : ""}.
          </p>
        ) : null}

        {!x.client.linked && x.client.suggestion ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-client-suggestion">
            <span>
              Another job for this client uses{" "}
              <span className="font-medium text-text">{x.client.suggestion.name}</span>.
            </span>
            <button
              type="button"
              className={LINK}
              disabled={busy}
              onClick={() => {
                if (x.client.suggestion) void link(x.client.suggestion);
              }}
            >
              Use this contact
            </button>
          </p>
        ) : null}

        {!x.settingsComplete ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-settings-incomplete">
            <span>The sales account, GST rate and payment terms for invoices aren&rsquo;t chosen yet.</span>
            <a href={XERO_SETTINGS_PATH} className={LINK}>
              Choose them
            </a>
          </p>
        ) : null}
      </div>

      {picking ? (
        <XeroContactPicker
          initialQuery={data.job.clientName ?? ""}
          organisationName={x.organisationName}
          busy={busy}
          onClose={() => setPicking(false)}
          onPick={link}
        />
      ) : null}
    </>
  );
}

type SearchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; contacts: XeroContact[]; query: string }
  | { kind: "error"; message: string };

/**
 * Search the connected Xero organisation's contacts and pick one. The search
 * is live (nothing is cached) and starts from the job's client name. A new
 * client is created in Xero, not here — BuhlOS never creates a contact.
 */
export function XeroContactPicker({
  initialQuery,
  organisationName,
  busy,
  onClose,
  onPick,
  search = searchXeroContacts,
}: {
  initialQuery: string;
  organisationName: string | null;
  busy: boolean;
  onClose: () => void;
  onPick: (contact: XeroContact) => Promise<boolean>;
  /** Injectable for tests. */
  search?: (q: string) => Promise<HttpResult<XeroContact[]>>;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setState({ kind: "idle" });
      return;
    }
    // Debounce typing; ignore any answer that isn't for the newest request.
    const ticket = ++latest.current;
    setState({ kind: "searching" });
    const timer = setTimeout(() => {
      void search(q).then((res) => {
        if (ticket !== latest.current) return;
        if (res.ok) setState({ kind: "results", contacts: res.data, query: q });
        else
          setState({
            kind: "error",
            message: errorMessage(errorCodeOf(res.error.body), res.error.status),
          });
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Link this job's client in Xero">
      <div className="grid gap-3" data-testid="xero-contact-picker">
        <div>
          <label htmlFor="xero-contact-search" className="block text-sm font-medium text-text">
            Search {organisationName ? `${organisationName}'s` : "your"} Xero contacts
          </label>
          <input
            id="xero-contact-search"
            className="mt-1 h-10 w-full rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Start typing the client's name"
            disabled={busy}
            autoComplete="off"
          />
        </div>

        <div className="min-h-[6rem]" aria-live="polite">
          <ContactResults state={state} busy={busy} onPick={onPick} />
        </div>

        <p className="text-xs text-text-muted">
          Can&rsquo;t find them? Add the client as a contact in Xero first, then search again.
        </p>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The picker's result area — a pure function of the search state. */
export function ContactResults({
  state,
  busy,
  onPick,
}: {
  state: SearchState;
  busy: boolean;
  onPick: (contact: XeroContact) => Promise<boolean> | void;
}) {
  if (state.kind === "idle") {
    return <p className="text-sm text-text-muted">Type at least two letters to search.</p>;
  }
  if (state.kind === "searching") {
    return <p className="text-sm text-text-muted">Searching Xero…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="text-sm text-state-danger-subtle-text" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.contacts.length === 0) {
    return (
      <p className="text-sm text-text-muted" data-testid="xero-contact-none">
        No active Xero contact matches &ldquo;{state.query}&rdquo;.
      </p>
    );
  }
  return (
    <ul className="grid gap-1" data-testid="xero-contact-results">
      {state.contacts.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2 text-left text-sm text-text hover:border-brand-navy disabled:opacity-60"
            disabled={busy}
            onClick={() => void onPick(c)}
          >
            <span className="min-w-0 truncate">{c.name}</span>
            <span className="shrink-0 text-xs text-text-muted">Link</span>
          </button>
        </li>
      ))}
      {state.contacts.length >= 20 ? (
        <li className="text-xs text-text-muted">
          Showing the first 20. Type more of the name to narrow it down.
        </li>
      ) : null}
    </ul>
  );
}
