"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  getQuoteDelivery,
  markQuoteSent,
  markQuoteViewed,
  type DeliveryState,
} from "@/domains/quoting/delivery-client";

/**
 * Quote client-status card (#240) on the quote detail page. Shows the client-
 * facing lifecycle — sent → viewed → accepted/declined — with the dates, and
 * lets the office record a send (date/recipient/method) or a manual view.
 * Viewed is never inferred (untracked reads "not tracked"); accept/decline come
 * from the existing acceptance/status flow.
 */

const STATE_LABEL: Record<DeliveryState["state"], string> = {
  never_sent: "Not sent yet",
  sent: "Sent — awaiting client",
  viewed: "Viewed — awaiting decision",
  accepted: "Accepted",
  declined: "Declined",
};
const STATE_TONE: Record<DeliveryState["state"], "neutral" | "info" | "warning" | "success" | "danger"> = {
  never_sent: "neutral",
  sent: "info",
  viewed: "warning",
  accepted: "success",
  declined: "danger",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function QuoteDeliveryCard({ quoteId }: { quoteId: string }) {
  const [d, setD] = useState<DeliveryState | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "error">("loading");
  const [form, setForm] = useState<null | { at: string; recipient: string; method: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getQuoteDelivery(quoteId);
      if (cancelled) return;
      if (!res.ok) { setView("error"); return; }
      setD(res.data);
      setView("ready");
    })();
    return () => { cancelled = true; };
  }, [quoteId]);

  async function submitSent() {
    if (!form) return;
    if (!form.recipient.trim()) { setError("Who did you send it to?"); return; }
    setBusy(true); setError(null);
    const res = await markQuoteSent(quoteId, form);
    setBusy(false);
    if (!res.ok) { setError(res.error.message); return; }
    setD(res.data); setForm(null);
  }

  async function doMarkViewed() {
    setBusy(true); setError(null);
    const res = await markQuoteViewed(quoteId, {});
    setBusy(false);
    if (!res.ok) { setError(res.error.message); return; }
    setD(res.data);
  }

  const inputClass = "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm";
  const terminal = d?.state === "accepted" || d?.state === "declined";

  return (
    <Card role="region" aria-label="Quote client status">
      <CardTitle>Client status</CardTitle>
      <CardDescription className="mt-1">
        Where this quote sits with the client — sent, viewed, then accepted or declined.
      </CardDescription>

      {view === "loading" ? (
        <p className="mt-3 text-sm text-text-muted">Loading…</p>
      ) : view === "error" || !d ? (
        <p className="mt-3 text-sm text-text-muted">Couldn&rsquo;t load the client status.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone={STATE_TONE[d.state]}>{STATE_LABEL[d.state]}</Pill>
            {d.since ? (
              <span className="font-mono text-[11px] text-text-muted">since {d.since.slice(0, 10)}</span>
            ) : null}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <Fact label="Sent" value={d.lastSentAt ? `${d.lastSentAt}${d.recipient ? ` → ${d.recipient}` : ""}${d.method ? ` (${d.method})` : ""}` : "not sent"} muted={!d.lastSentAt} />
            <Fact label="Viewed" value={d.lastViewedAt ?? "not tracked"} muted={!d.lastViewedAt} />
          </dl>

          {error ? (
            <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>
          ) : null}

          {!terminal ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setForm(form ? null : { at: todayIso(), recipient: "", method: "email" })} data-testid="quote-mark-sent-open">
                {d.state === "never_sent" ? "Record send" : "Record another send"}
              </Button>
              {d.state !== "never_sent" ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={doMarkViewed} data-testid="quote-mark-viewed">
                  Mark viewed
                </Button>
              ) : null}
            </div>
          ) : null}

          {form ? (
            <div className="mt-2 grid gap-2 rounded-card border border-border p-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-text-muted">
                  Date
                  <input type="date" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} className={inputClass} />
                </label>
                <label className="block text-xs text-text-muted">
                  Method
                  <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={inputClass} aria-label="Send method">
                    <option value="email">Email</option>
                    <option value="portal">Portal</option>
                    <option value="hand">By hand</option>
                    <option value="post">Post</option>
                    <option value="other">Other</option>
                  </select>
                </label>
              </div>
              <input type="text" value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} placeholder="Sent to (name or email)" className={inputClass} aria-label="Recipient" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
                <Button size="sm" onClick={submitSent} disabled={busy} data-testid="quote-mark-sent-save">Save</Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className={`mt-0.5 text-sm ${muted ? "text-text-muted" : "text-text"}`}>{value}</dd>
    </div>
  );
}
