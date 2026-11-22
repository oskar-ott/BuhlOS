"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { issueJobCode } from "@/domains/jobs/client";

/**
 * "Give this job a number" — for a job that has none (#1152, job_code_auto).
 *
 * Sits where the job's number shows on the hub hero. BuhlOS issues the next
 * number; it can't be chosen, and a job's number is never changed afterwards,
 * so the action says that before it happens (one confirm, inline).
 *
 * Rendered only for the office tier while the flag is on and the job has no
 * number; the server enforces all three again.
 */
export function GiveJobNumber({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "asking" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);

  async function give() {
    setStage("busy");
    setError(null);
    const res = await issueJobCode(jobId);
    if (!res.ok) {
      setError(res.error.message || "Couldn't get a job number just now. Nothing was changed.");
      setStage("idle");
      return;
    }
    // The page is server-rendered from the job: re-read it so the number
    // shows in its usual place.
    router.refresh();
  }

  const link =
    "font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 disabled:opacity-60";

  return (
    <div className="text-xs text-text-muted" data-testid="give-job-number">
      {stage === "idle" ? (
        <p>
          No job number yet.{" "}
          <button type="button" className={link} onClick={() => setStage("asking")}>
            Give this job a number
          </button>
        </p>
      ) : (
        <p>
          BuhlOS will give this job the next free number. A job number can&rsquo;t be changed
          afterwards.{" "}
          <button
            type="button"
            className={link}
            disabled={stage === "busy"}
            onClick={() => void give()}
            data-testid="give-job-number-yes"
          >
            {stage === "busy" ? "Getting a number…" : "Yes, give it a number"}
          </button>{" "}
          {stage === "asking" ? (
            <button type="button" className={link} onClick={() => setStage("idle")}>
              Cancel
            </button>
          ) : null}
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-state-danger-subtle-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
