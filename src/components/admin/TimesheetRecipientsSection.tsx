"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Timesheet-recipients section (owner pull 2026-08-16) — a self-fetching
 * client island over `GET`/`PUT /api/time-entries-email`, on the /settings
 * hub. The list it edits IS the switch for the interim send-to-accounts
 * export: at least one address → the "Send to Tia" surfaces render (pay-period
 * card + phone closeout finale); empty → they disappear and the Xero finale
 * gets its slot back.
 *
 * Add and remove both PUT the FULL list (1–10 entries — per-row CAS would be
 * ceremony). The server re-validates every address and journals each change;
 * this panel re-renders from the SERVER's response, never its own guess.
 * Mirrors HoursPolicySection: self-fetch on mount, `canEdit` gates the
 * controls (the endpoint is admin-tier server-side regardless).
 */

type LoadState = "loading" | "ready" | "error";

interface RecipientsDoc {
  recipients: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

function parseDoc(json: unknown): RecipientsDoc | null {
  if (!json || typeof json !== "object") return null;
  const d = json as { recipients?: unknown; updatedAt?: unknown; updatedBy?: unknown };
  if (!Array.isArray(d.recipients)) return null;
  return {
    recipients: d.recipients.filter((r): r is string => typeof r === "string"),
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
    updatedBy: typeof d.updatedBy === "string" ? d.updatedBy : null,
  };
}

function formatUpdated(doc: RecipientsDoc): string | null {
  if (!doc.updatedAt) return null;
  const when = new Date(doc.updatedAt);
  const stamp = Number.isNaN(when.getTime())
    ? doc.updatedAt
    : when.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
  return doc.updatedBy ? `Last changed ${stamp} by ${doc.updatedBy}.` : `Last changed ${stamp}.`;
}

export function TimesheetRecipientsSection({ canEdit }: { canEdit: boolean }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [doc, setDoc] = useState<RecipientsDoc | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/time-entries-email", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const parsed = parseDoc(await res.json());
        if (!alive) return;
        if (!parsed) {
          setLoad("error");
          return;
        }
        setDoc(parsed);
        setLoad("ready");
      } catch {
        if (alive) setLoad("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Replace the whole list; render whatever the SERVER persisted.
  const save = async (next: string[]) => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/time-entries-email", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipients: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveError(
          (data as { error?: string } | null)?.error ||
            `The save failed (${res.status}) — the list is unchanged.`,
        );
        return false;
      }
      const parsed = parseDoc(data);
      if (parsed) setDoc(parsed);
      return true;
    } catch {
      setSaveError("Couldn't reach the server — the list is unchanged.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!doc) return;
    const email = input.trim();
    if (!email) return;
    if (await save([...doc.recipients, email])) setInput("");
  };

  const remove = (email: string) => {
    if (!doc) return;
    void save(doc.recipients.filter((r) => r !== email));
  };

  if (load === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-text-muted" data-testid="timesheet-recipients-loading">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        Loading the recipient list…
      </p>
    );
  }

  if (load === "error" || !doc) {
    return (
      <p className="text-sm text-text-muted" role="status">
        Couldn&rsquo;t load the recipient list. Reload the page to try again.
      </p>
    );
  }

  const updated = formatUpdated(doc);

  return (
    <div className="space-y-3" data-testid="timesheet-recipients">
      {doc.recipients.length === 0 ? (
        <p className="rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2.5 text-sm text-text-muted">
          No recipients yet — <b className="font-semibold text-text">Send to Tia is switched off</b>{" "}
          until you add an address.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
          {doc.recipients.map((email) => (
            <li key={email} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-text">{email}</span>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-text-muted"
                  onClick={() => remove(email)}
                  disabled={busy}
                  aria-label={`Remove ${email}`}
                  data-testid={`timesheet-recipient-remove-${email}`}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="name@example.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 rounded-card border border-border px-3 py-2 text-sm text-text placeholder:text-text-muted"
            aria-label="Email address to add"
            data-testid="timesheet-recipient-input"
          />
          <Button type="submit" disabled={busy || !input.trim()} data-testid="timesheet-recipient-add">
            {busy ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plus aria-hidden="true" className="h-4 w-4" />
            )}
            Add
          </Button>
        </form>
      ) : null}

      {saveError ? (
        <p className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" role="status">
          {saveError}
        </p>
      ) : null}

      <p className="text-xs text-text-muted">
        Everyone listed gets the approved-hours PDF in the one email when you hit Send to Tia.
        Remove every address to switch the send option off (the Xero finale comes back).
        {updated ? ` ${updated}` : ""}
      </p>
    </div>
  );
}
