"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { acknowledgeSafetyDoc } from "@/domains/safety-docs/client";
import { SAFETY_DOC_TYPE_LABEL, type SafetyDoc } from "@/domains/safety-docs/schema";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilNotice } from "./ui/PhilNotice";

/**
 * Field side of safety documents (#219). The worker opens each SWMS / SDS and
 * taps "I've read this". The acknowledgement carries no identity — the server
 * attributes it from the session. Read marks stick once recorded.
 */
export function PhilSafetyDocs({
  jobId,
  initialDocuments,
  initialAckedIds,
  fetchError,
}: {
  jobId: string;
  initialDocuments: SafetyDoc[];
  initialAckedIds: string[];
  fetchError: string | null;
}) {
  const [acked, setAcked] = useState<Set<string>>(new Set(initialAckedIds));
  const [error, setError] = useState<string | null>(fetchError);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function ack(docId: string) {
    setBusyId(docId);
    setError(null);
    try {
      await acknowledgeSafetyDoc(jobId, docId);
      setAcked((s) => new Set(s).add(docId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record that — try again");
    } finally {
      setBusyId(null);
    }
  }

  if (initialDocuments.length === 0) {
    return (
      <PhilNotice tone="info" title="Nothing to read here">
        <p>There are no safety documents on this job yet.</p>
      </PhilNotice>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <PhilNotice tone="warning" title="That didn’t save" role="alert">
          <p>{error}</p>
        </PhilNotice>
      )}
      {initialDocuments.map((doc) => {
        const isAcked = acked.has(doc.id);
        return (
          <Card key={doc.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{doc.title}</CardTitle>
                <CardDescription className="mt-0.5">
                  {SAFETY_DOC_TYPE_LABEL[doc.type]} · v{doc.version}
                </CardDescription>
              </div>
              {isAcked ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">
                  <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                  Read
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-card border border-border bg-surface px-4 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                Open document
              </a>
              {isAcked ? (
                <span className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-card border border-emerald-200 bg-emerald-50 px-4 text-sm font-medium text-emerald-800">
                  You’ve read this ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => ack(doc.id)}
                  disabled={busyId === doc.id}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-card bg-text px-4 text-sm font-medium text-surface transition-colors hover:bg-text/90 disabled:opacity-50"
                >
                  {busyId === doc.id ? "Saving…" : "I’ve read this"}
                </button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
