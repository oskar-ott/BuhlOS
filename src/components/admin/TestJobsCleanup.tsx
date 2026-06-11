"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { deleteTestJob } from "@/domains/jobs/client";

interface Props {
  /**
   * Deletable QA test jobs (QA-prefixed AND not active) — the server
   * component filters with isDeletableTestJob before rendering this, so
   * an empty list means the control simply doesn't appear.
   */
  jobs: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Admin jobs index — one-shot cleanup for parked automated-test jobs.
 *
 * Smoke runs create SMOKE_TEST_<run> jobs and park them as Draft
 * (docs/testing/Test-Data-Rules.md), so the admin index accumulates a row
 * of junk per QA run with no way to remove it. This control deletes every
 * parked test job in one confirmed action via DELETE /api/jobs — an
 * endpoint that refuses real jobs and active jobs server-side, so the
 * worst case here is a 400, never lost work. The live QA fixture
 * (QA_SEED_FIELD_ACTIVE_JOB) is active, hence never offered.
 *
 * Confirmation is an inline arm/confirm step (house rule: no window
 * confirm()/alert() — see EvidenceRejectModal). Deletes run sequentially;
 * partial failures are reported and the list refreshes either way.
 */
export function TestJobsCleanup({ jobs }: Props) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (jobs.length === 0) return null;

  const noun = jobs.length === 1 ? "test job" : "test jobs";

  async function run() {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let done = 0;
    for (const job of jobs) {
      const result = await deleteTestJob(job.id);
      if (!result.ok) failures.push(`${job.name}: ${result.error.message}`);
      done += 1;
      setProgress(done);
    }
    if (failures.length > 0) {
      setError(`${failures.length} of ${jobs.length} could not be deleted — ${failures[0]}`);
      setBusy(false);
      setArmed(false);
    }
    // Refresh regardless: rows that did delete should leave the list.
    router.refresh();
  }

  return (
    <Card data-testid="test-jobs-cleanup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Automated test data</CardTitle>
          <CardDescription className="mt-1">
            {jobs.length} parked {noun} from QA smoke runs {jobs.length === 1 ? "is" : "are"}{" "}
            sitting in this list. Deleting test data never touches real jobs.
          </CardDescription>
        </div>
        {busy ? (
          <span className="text-sm text-text-muted" data-testid="test-jobs-cleanup-busy">
            Deleting… {progress}/{jobs.length}
          </span>
        ) : armed ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setArmed(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              data-testid="test-jobs-cleanup-confirm"
              onClick={() => void run()}
            >
              Yes, delete {jobs.length} {noun}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            data-testid="test-jobs-cleanup-arm"
            onClick={() => setArmed(true)}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete {jobs.length} {noun}…
          </Button>
        )}
      </div>
      {error ? (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
