"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resolveScopeFinding } from "./jobControlAuthoringClient";

/**
 * Resolve-or-accept actions for ONE open reconciliation finding (#366 AC2).
 * Two decisions, both writes through the existing reconciliation confirm route
 * (authoritative admin gate + stale-source protection server-side):
 *
 *   - "Mark resolved" — the underlying conflict was actually fixed (the scope
 *     or quote was corrected, the obligation moved, etc.).
 *   - "Accept with reason" — the office lives with it, and MUST say why. The
 *     accept button stays disabled until a reason is typed; the route also
 *     400s a reasonless accept, so the rule holds even off this UI.
 *
 * On success it refreshes the server-loaded view: the engine excludes resolved
 * keys from the open findings, so the finding leaves the list and the RAG
 * recomputes — this component renders decisions, it never derives them.
 */
export function ScopeFindingActions({
  jobId,
  findingKey,
  sourceHash,
}: {
  jobId: string;
  findingKey: string;
  /** The confirmed view's scope fingerprint — sent so a scope change since the
   *  page loaded is rejected (409) instead of silently written over. */
  sourceHash: string;
}) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<null | "resolved" | "accepted">(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "resolved" | "accepted") {
    setBusy(action);
    setError(null);
    const res = await resolveScopeFinding(jobId, {
      findingKey,
      action,
      ...(action === "accepted" ? { reason: reason.trim() } : {}),
      sourceHash,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    // Server components re-read the persisted reconciliation; the finding
    // leaves the open list and the RAG badge updates.
    router.refresh();
  }

  const btn =
    "rounded-card border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-50";

  return (
    <div className="mt-1.5 w-full">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          data-testid="scope-finding-resolve"
          disabled={busy !== null}
          onClick={() => submit("resolved")}
        >
          {busy === "resolved" ? "Saving…" : "Mark resolved"}
        </button>
        <button
          type="button"
          className={btn}
          data-testid="scope-finding-accept"
          disabled={busy !== null}
          aria-expanded={accepting}
          onClick={() => setAccepting((v) => !v)}
        >
          Accept with reason
        </button>
      </div>
      {accepting ? (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <textarea
            className="min-h-[3.5rem] w-full max-w-md rounded-card border border-border bg-surface px-2.5 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
            data-testid="scope-finding-accept-reason"
            placeholder="Why is this OK to live with? e.g. disposal agreed with the builder by email"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className={btn}
            data-testid="scope-finding-accept-confirm"
            disabled={busy !== null || !reason.trim()}
            onClick={() => submit("accepted")}
          >
            {busy === "accepted" ? "Saving…" : "Accept"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="mt-1.5 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
