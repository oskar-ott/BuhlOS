"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { duplicateJob } from "@/domains/jobs/client";

/**
 * One-click "Duplicate job" (#190) — creates a NEW draft copying structure +
 * site basics (fresh ids, archived entries skipped, nothing operational), then
 * lands the office in the copy's builder. The copy is a draft, invisible to
 * the field until published, so the action is cheap and reversible (park it).
 */
export function DuplicateJobButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function duplicate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await duplicateJob(jobId);
    if (result.ok) {
      router.push(`/v2/jobs/${encodeURIComponent(result.data.job.id)}/builder`);
      return;
    }
    setBusy(false);
    setError(
      result.error.status === 403
        ? "Duplicating a job needs an admin login."
        : result.error.message || "Couldn't duplicate. Try again."
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" onClick={duplicate} disabled={busy}>
        <Copy aria-hidden="true" className="h-4 w-4" />
        {busy ? "Duplicating…" : "Duplicate job"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-state-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
