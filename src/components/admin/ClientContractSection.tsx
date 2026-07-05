"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { updateJob } from "@/domains/jobs/client";
import type { Job } from "@/domains/jobs/types";

/**
 * Client & contract editor (#228) — the builder's Basics tab, beneath the
 * scope of work. Three commercial facts that belong WITH the job instead of
 * in an inbox or Xero:
 *   - client reference: a free-text PO / contract / client job number. This
 *     is deliberately NOT clientUserId — that field links a portal account;
 *     this is the commercial label the office quotes against. (#228 PR note.)
 *   - contract value: the agreed figure, in DOLLARS (the same unit the
 *     stored job.contractValue has always used; the server ×100s it for the
 *     cents-based profitability/closeout views).
 *   - contract notes: key terms, inclusions/exclusions, payment terms.
 *
 * Admin-tier ONLY, enforced SERVER-SIDE, not just hidden here: api/jobs.js
 * 403s a leadingHand PUT of these fields and job-redaction.js strips them
 * from every non-admin read, so a tradie's phone / a client's browser never
 * receives them. Saved as its OWN PUT (the scopeOfWork precedent) — the
 * wholesale builder save (buildUpdatePayload) still omits money fields, so
 * this section can't be clobbered by an unrelated Basics save.
 */
export function ClientContractSection({
  job,
  onDirtyChange,
}: {
  job: Job;
  /** Report unsaved-edit state up so the builder can guard tab navigation. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [clientReference, setClientReference] = useState(job.clientReference ?? "");
  const [contractValue, setContractValue] = useState(
    job.contractValue != null ? String(job.contractValue) : ""
  );
  const [contractNotes, setContractNotes] = useState(job.contractNotes ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Report unsaved edits up (builder tab-nav guard); clear on unmount.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const touch = () => {
    setDirty(true);
    setSavedAt(null);
  };

  // Contract value is dollars; blank clears it. Reject anything that isn't a
  // non-negative number so we never send a NaN the server would 400 on.
  const cvRaw = contractValue.trim();
  const cvNumber = cvRaw === "" ? null : Number(cvRaw);
  const cvInvalid = cvRaw !== "" && (!Number.isFinite(cvNumber) || (cvNumber as number) < 0);

  async function save() {
    if (cvInvalid) return;
    setBusy(true);
    setError(null);
    const res = await updateJob({
      id: job.id,
      clientReference: clientReference.trim() || null,
      contractValue: cvNumber,
      // Preserve the user's line breaks; only the empty check is trimmed.
      contractNotes: contractNotes.trim() ? contractNotes : null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setDirty(false);
    setSavedAt(new Date().toISOString());
    router.refresh();
  }

  return (
    <Card role="region" aria-label="Client and contract">
      <CardTitle>Client &amp; contract</CardTitle>
      <CardDescription className="mt-1">
        Commercial context that lives with the job. Office-only — the field
        and the client portal never see any of it.
      </CardDescription>

      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-text">Client reference</span>
          <input
            value={clientReference}
            onChange={(e) => {
              setClientReference(e.target.value);
              touch();
            }}
            placeholder="PO number, contract ref or the client's job number"
            maxLength={200}
            className="mt-1 h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
            data-testid="contract-ref"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-text">Contract value (AUD)</span>
          <div className="mt-1 flex items-center gap-2">
            <span aria-hidden="true" className="text-sm text-text-muted">
              $
            </span>
            <input
              value={contractValue}
              onChange={(e) => {
                setContractValue(e.target.value);
                touch();
              }}
              inputMode="decimal"
              placeholder="e.g. 50000"
              className="h-9 w-40 rounded-card border border-border bg-surface px-2 text-sm"
              data-testid="contract-value"
            />
          </div>
          {cvInvalid ? (
            <span className="mt-1 block text-xs text-rose-700">
              Enter a non-negative dollar amount, or leave blank to clear it.
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-text">Contract notes / terms</span>
          <textarea
            value={contractNotes}
            onChange={(e) => {
              setContractNotes(e.target.value);
              touch();
            }}
            placeholder="Key terms, inclusions / exclusions, payment terms"
            rows={3}
            maxLength={4000}
            className="mt-1 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
            data-testid="contract-notes"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={busy || !dirty || cvInvalid}
          data-testid="contract-save"
        >
          {busy ? "Saving…" : "Save client & contract"}
        </Button>
        {savedAt ? <span className="text-xs text-state-success">Saved.</span> : null}
      </div>
    </Card>
  );
}
