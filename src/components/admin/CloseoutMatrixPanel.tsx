"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import type {
  CloseoutMatrixView,
  CloseoutRequirementView,
} from "@/server/job-control/closeout-read";

/**
 * Closeout matrix authoring panel (#374) — the admin click-path on
 * /v2/jobs/[jobId]/closeout. Renders the requirements matrix (status, links,
 * confirmation) and the per-requirement actions: confirm / un-confirm, waive /
 * un-waive, remove. Each action POSTs one op to /api/job-control/closeout/confirm
 * (HMAC admin-gated) with the artifact `revision` as the stale-write precondition,
 * then refreshes the server-rendered page so the re-derived status is authoritative.
 *
 * Read-only with respect to job completion — nothing here freezes or gates the
 * job's close-out (#349 owns that).
 *
 * The status shown is whatever the server re-derived (links + confirmation +
 * live ids); the panel never invents a "satisfied" client-side.
 */

type Busy = { id: string; op: string } | null;

export function CloseoutMatrixPanel({
  jobId,
  view,
}: {
  jobId: string;
  view: CloseoutMatrixView;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  if (!view.ok) {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t read the closeout matrix</CardTitle>
        <CardDescription className="text-amber-900">Try again in a moment.</CardDescription>
      </Card>
    );
  }

  if (view.status === "missing") {
    return (
      <Card>
        <CardTitle>Nothing to close out yet</CardTitle>
        <CardDescription className="mt-2">
          This job has no compiled job-control spine, so there are no closeout
          obligations to track. Reconcile and compile the job first.
        </CardDescription>
      </Card>
    );
  }

  if (view.status === "unreadable") {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>The job-control spine is unreadable</CardTitle>
        <CardDescription className="text-amber-900">
          Inspect or restore it before tracking closeout.
        </CardDescription>
      </Card>
    );
  }

  if (view.counts.total === 0) {
    return (
      <Card>
        <CardTitle>Nothing to close out yet</CardTitle>
        <CardDescription className="mt-2">
          No closeout obligations have been seeded for this job.
        </CardDescription>
      </Card>
    );
  }

  const { counts, requirements, revision } = view;

  async function runOp(op: Record<string, unknown>, key: { id: string; op: string }) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/job-control/closeout/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ jobId, expectedJobControlRevision: revision, op }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (!res.ok) {
        setError(
          body.reason === "stale_revision"
            ? "This page is out of date — refresh and try again."
            : body.error ?? body.reason ?? `Save failed (${res.status}).`,
        );
        setBusy(null);
        return;
      }
      // Re-render the server component so the re-derived status is authoritative.
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Closeout readiness</CardTitle>
            <CardDescription className="mt-1">
              Read-only on completion — this tracks handover obligations, it
              doesn&rsquo;t freeze the job.
            </CardDescription>
          </div>
          <Pill
            tone={counts.discharged === counts.total ? "navy" : "warning"}
            className="shrink-0 font-semibold"
          >
            {counts.discharged} of {counts.total} closed out
          </Pill>
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            {error}
          </p>
        ) : null}
      </Card>

      <ul className="space-y-2">
        {requirements.map((req) => (
          <RequirementRow
            key={req.id}
            req={req}
            busy={busy?.id === req.id ? busy.op : null}
            onConfirm={(confirmed) =>
              runOp({ op: "confirm", requirementId: req.id, confirmed }, { id: req.id, op: "confirm" })
            }
            onWaive={(waived) =>
              runOp({ op: "waive", requirementId: req.id, waived }, { id: req.id, op: "waive" })
            }
            onRemove={() => runOp({ op: "remove", requirementId: req.id }, { id: req.id, op: "remove" })}
          />
        ))}
      </ul>
    </div>
  );
}

const STATUS_TONE: Record<string, "navy" | "warning" | "neutral"> = {
  satisfied: "navy",
  waived: "neutral",
  in_progress: "warning",
  outstanding: "warning",
};
const STATUS_LABEL: Record<string, string> = {
  satisfied: "Closed out",
  waived: "Waived",
  in_progress: "In progress",
  outstanding: "Outstanding",
};

function RequirementRow({
  req,
  busy,
  onConfirm,
  onWaive,
  onRemove,
}: {
  req: CloseoutRequirementView;
  busy: string | null;
  onConfirm: (confirmed: boolean) => void;
  onWaive: (waived: boolean) => void;
  onRemove: () => void;
}) {
  const confirmed = Boolean(req.confirmedAt);
  const waived = req.status === "waived";
  const anyBusy = busy != null;
  return (
    <li className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block font-display text-base font-semibold text-text">{req.title}</span>
          <span className="mt-0.5 block text-xs text-text-muted">
            {req.source === "clause" ? "From scope" : "Standing obligation"} · {req.kind}
            {req.links.length > 0
              ? ` · ${req.links.filter((l) => l.resolved).length}/${req.links.length} link${
                  req.links.length === 1 ? "" : "s"
                } resolve`
              : " · no linked record"}
          </span>
          {req.hasDanglingLink ? (
            <span className="mt-0.5 block text-xs text-amber-700">
              A linked record is missing — re-link before sign-off.
            </span>
          ) : null}
        </div>
        <Pill tone={STATUS_TONE[req.status] ?? "neutral"} className="shrink-0">
          {STATUS_LABEL[req.status] ?? req.status}
        </Pill>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {!waived ? (
          <Button
            size="sm"
            variant={confirmed ? "secondary" : "primary"}
            disabled={anyBusy}
            onClick={() => onConfirm(!confirmed)}
          >
            {busy === "confirm" ? "Saving…" : confirmed ? "Un-confirm" : "Confirm"}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => onWaive(!waived)}>
          {busy === "waive" ? "Saving…" : waived ? "Un-waive" : "Waive"}
        </Button>
        <Button size="sm" variant="ghost" disabled={anyBusy} onClick={onRemove}>
          {busy === "remove" ? "Removing…" : "Remove"}
        </Button>
      </div>
    </li>
  );
}
