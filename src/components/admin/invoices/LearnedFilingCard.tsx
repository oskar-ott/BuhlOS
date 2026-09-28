"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { forgetLearnedCategory, listLearnedCategories } from "@/domains/invoices/client";
import type { LearnedCategory, LearnedCategoryList } from "@/domains/invoices/schema";
import { categoryLabel, formatShortDate } from "@/domains/invoices/format";

/**
 * Task I (2026-09-27): "Remembered filing" — the product-category rules the
 * office created by re-filing line items (supplier + product key → category).
 * Every rule is listed with who set it and when, how many line items it
 * files right now, and a two-step **Forget**. Nothing here is written by AI
 * or OCR — only a person's re-file creates a rule, only a person removes it,
 * and the removal is audited. Collapsed by default; fetched when opened.
 */
export function LearnedFilingRow({ rule, busy, onForget }: { rule: LearnedCategory; busy: boolean; onForget: (id: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-border py-1.5 text-sm" data-testid={`learned-rule-${rule.id}`}>
      <span className="font-medium text-text">{rule.supplierKey ? (rule.supplierName ?? rule.supplierKey) : "Any supplier"}</span>
      <span className="font-mono text-xs text-text-muted">{rule.descriptionKey}</span>
      <span className="text-text">→ {categoryLabel(rule.category)}</span>
      <span className="text-xs text-text-muted">
        set by {rule.setBy ?? "unknown"}
        {rule.setAt ? ` · ${formatShortDate(rule.setAt)}` : ""} · files {rule.linesFiledNow} {rule.linesFiledNow === 1 ? "line" : "lines"} now
      </span>
      {confirm ? (
        <span className="inline-flex items-center gap-2 text-xs">
          Invoices already read keep their filing; the next one files by keyword again.
          <Button type="button" variant="danger" size="sm" disabled={busy} data-testid={`learned-rule-forget-confirm-${rule.id}`} onClick={() => { setConfirm(false); onForget(rule.id); }}>
            Yes, forget
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button type="button" variant="ghost" size="sm" disabled={busy} data-testid={`learned-rule-forget-${rule.id}`} onClick={() => setConfirm(true)}>
          Forget
        </Button>
      )}
    </li>
  );
}

export function LearnedFilingCard() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "hidden" | "error">("idle");
  const [data, setData] = useState<LearnedCategoryList | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const res = await listLearnedCategories();
    if (!res.ok) {
      setState(res.error.status === 401 || res.error.status === 403 || res.error.status === 404 ? "hidden" : "error");
      return;
    }
    setData(res.data);
    setState("ready");
  }, []);

  useEffect(() => {
    if (open && state === "idle") void load();
  }, [open, state, load]);

  async function forget(id: string) {
    setBusy(true);
    setMessage(null);
    const res = await forgetLearnedCategory(id);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.error.status === 404 ? "That rule was already gone." : "Couldn't forget it just now — try again.");
      if (res.error.status === 404) void load();
      return;
    }
    setData(res.data);
    setMessage("Forgotten. Invoices already read keep their filing; the next one files by keyword again.");
  }

  if (state === "hidden") return null;
  return (
    <Card data-testid="learned-filing-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardKicker>Remembered filing</CardKicker>
        <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="learned-filing-toggle">
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        When you re-file a line item, BuhlOS remembers that supplier&rsquo;s product under that category and files it the same way
        next time. Only a person creates a rule; only a person removes one, and the removal is kept on record.
      </p>
      {open ? (
        state === "loading" || state === "idle" ? (
          <div className="mt-3 h-8 animate-pulse rounded bg-surface-subtle" data-testid="learned-filing-skeleton" />
        ) : state === "error" ? (
          <p className="mt-3 text-sm text-text-muted">Could not load the remembered filing just now.</p>
        ) : data && data.rules.length ? (
          <>
            <p className="mt-3 text-xs text-text-muted" data-testid="learned-filing-count">
              {data.total} {data.total === 1 ? "rule" : "rules"}
              {data.total > data.rules.length ? ` (showing the newest ${data.rules.length})` : ""}
            </p>
            <ul className="mt-1" data-testid="learned-filing-rules">
              {data.rules.map((r) => (
                <LearnedFilingRow key={r.id} rule={r} busy={busy} onForget={(id) => void forget(id)} />
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-sm text-text-muted">Nothing remembered yet — re-file a line item on an invoice and it appears here.</p>
        )
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-text-muted" role="status" data-testid="learned-filing-message">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
