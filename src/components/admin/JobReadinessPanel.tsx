"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import {
  computeReadiness,
  readinessStateLabel,
  readinessStateTone,
  type ReadinessItem,
  type ReadinessItemStatus,
  type ReadinessResult,
} from "@/domains/jobs/readiness";
import {
  clearReadinessOverride,
  setReadinessOverride,
  signalsFrom,
  tickPrestartItem,
} from "@/domains/jobs/readiness-client";

/**
 * Job hub — pre-start readiness panel (#371). Renders the honest
 * `computeReadiness()` result and lets the office tick the manual obligations
 * and record an override-with-reason. The override approves START but never
 * flips the honest state and never renders green (the engine guarantees it;
 * this panel must not undo that). Admin-tier only — an LH viewer never gets
 * this card (the hub fetch resolves to null on the API's 403).
 */

interface JobReadinessPanelProps {
  jobId: string;
  initial: ReadinessResult;
  fetchError: string | null;
}

const ITEM_TONE: Record<ReadinessItemStatus, "success" | "warning" | "danger"> = {
  satisfied: "success",
  warning: "warning",
  not_tracked: "warning",
  missing: "danger",
};
const ITEM_LABEL: Record<ReadinessItemStatus, string> = {
  satisfied: "OK",
  warning: "Check",
  not_tracked: "Not tracked",
  missing: "Outstanding",
};

export function JobReadinessPanel({ jobId, initial, fetchError }: JobReadinessPanelProps) {
  const router = useRouter();
  const [result, setResult] = useState<ReadinessResult>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");

  function applyResult(
    res: Awaited<ReturnType<typeof tickPrestartItem>>
  ): boolean {
    if (!res.ok) {
      setError(res.error.message);
      return false;
    }
    setResult(computeReadiness(signalsFrom(res.data)));
    router.refresh();
    return true;
  }

  async function onTick(item: ReadinessItem) {
    const id = item.key.replace(/^manual:/, "");
    setBusy(true);
    setError(null);
    const res = await tickPrestartItem(jobId, id, item.status !== "satisfied");
    setBusy(false);
    applyResult(res);
  }

  async function onOverride() {
    setBusy(true);
    setError(null);
    const res = await setReadinessOverride(jobId, reason.trim());
    setBusy(false);
    if (applyResult(res)) {
      setOverriding(false);
      setReason("");
    }
  }

  async function onClearOverride() {
    setBusy(true);
    setError(null);
    const res = await clearReadinessOverride(jobId);
    setBusy(false);
    applyResult(res);
  }

  const { state, items, override, overridden, blockingCount } = result;

  return (
    <Card role="region" aria-label="Pre-start readiness">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck aria-hidden="true" className="h-5 w-5 text-brand-navy" />
          <div>
            <CardTitle>Pre-start readiness</CardTitle>
            <CardDescription className="mt-0.5">
              Can we start? Computed from induction, licences, safety docs and the
              manual checklist — real records only.
            </CardDescription>
          </div>
        </div>
        <Pill tone={readinessStateTone(state)} data-testid="readiness-state">
          {readinessStateLabel(state)}
        </Pill>
      </div>

      {fetchError ? <p className="mt-2 text-sm text-text-muted">{fetchError}</p> : null}
      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}

      {overridden && override ? (
        <div
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="readiness-override-flag"
        >
          <p className="font-display font-semibold">
            Start approved by override — not all checks pass
          </p>
          <p className="mt-0.5">
            {override.reason} · {override.by} · {formatDay(override.at)}
          </p>
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClearOverride}
              data-testid="readiness-override-clear"
            >
              Clear override
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="mt-3 divide-y divide-border text-sm">
        {items.map((item) => (
          <li key={item.key} className="py-2" data-testid={`readiness-item-${item.key}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="font-medium text-text">{item.label}</span>
                <span className="block text-text-muted">{item.detail}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Pill tone={ITEM_TONE[item.status]}>{ITEM_LABEL[item.status]}</Pill>
                {item.key.startsWith("manual:") ? (
                  <Button
                    size="sm"
                    variant={item.status === "satisfied" ? "ghost" : "secondary"}
                    disabled={busy}
                    onClick={() => onTick(item)}
                    data-testid={`readiness-tick-${item.key.replace(/^manual:/, "")}`}
                  >
                    {item.status === "satisfied" ? "Un-tick" : "Tick"}
                  </Button>
                ) : null}
              </span>
            </div>
            {item.workers && item.workers.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-xs text-text-muted">
                {item.workers.map((w) => (
                  <li key={w.id} className={w.ok ? "" : "font-medium text-rose-700"}>
                    {w.ok ? "✓" : "•"} {w.name}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      {state !== "yes" && !overridden ? (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setOverriding(true)}
            data-testid="readiness-override-open"
          >
            Override — start anyway with a reason
          </Button>
          <p className="mt-1 text-xs text-text-muted">
            {blockingCount > 0
              ? "Records a reason and approves the start despite outstanding items. Never marks the job ready."
              : "Approves the start despite warnings. Never marks the job ready."}
          </p>
        </div>
      ) : null}

      <Modal open={overriding} onClose={() => setOverriding(false)} title="Override pre-start readiness?">
        <p className="text-sm text-text-muted">
          This records who approved the start and why. It does not mark the checks
          as passed — the honest status stays as it is.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required) — e.g. client signed a waiver for the outstanding SWMS"
          className="mt-3 w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
          rows={3}
          data-testid="readiness-override-reason"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOverriding(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onOverride}
            disabled={busy || !reason.trim()}
            data-testid="readiness-override-confirm"
          >
            Record override
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
