"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { listGear, reportGear, transferGear } from "@/domains/gear/client";
import { buildReturnToDepotPayload, deriveStatus, statusTone } from "@/domains/gear/service";
import {
  conditionLabel,
  formatShortDate,
  formatTimestamp,
  isOverdue,
  statusLabel,
  typeLabel,
} from "@/domains/gear/format";
import type { GearAsset, ReportKind } from "@/domains/gear/types";

interface Props {
  initialAssets: ReadonlyArray<GearAsset>;
}

type ConfirmAction = {
  asset: GearAsset;
  kind: "return" | ReportKind;
} | null;

export function PhilGearList({ initialAssets }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<ReadonlyArray<GearAsset>>(initialAssets);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  async function refresh() {
    const result = await listGear();
    if (result.ok) setAssets(result.data.assets.filter((a) => a.currentHolderId));
  }

  function runAction() {
    if (!confirm) return;
    const { asset, kind } = confirm;
    // Close the sheet up front so the worker sees an immediate response and
    // can't double-tap. The async result lands as a banner instead.
    setConfirm(null);
    setErrorMessage(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result =
        kind === "return"
          ? await transferGear(buildReturnToDepotPayload({ id: asset.id }))
          : await reportGear({ assetId: asset.id, kind });
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSuccessMessage(
        kind === "return"
          ? `Returned ${asset.name} to depot`
          : kind === "check"
            ? `Confirmed ${asset.name}`
            : kind === "damaged"
              ? `Reported ${asset.name} as damaged`
              : `Reported ${asset.name} as missing`
      );
      await refresh();
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {errorMessage ? (
        <Card className="border-rose-200 bg-rose-50" role="alert">
          <p className="text-sm text-rose-900">{errorMessage}</p>
        </Card>
      ) : null}
      {successMessage ? (
        <Card className="border-emerald-200 bg-emerald-50" role="status">
          <p className="text-sm text-emerald-900">{successMessage}</p>
        </Card>
      ) : null}

      <ul className="space-y-3">
        {assets.map((asset) => {
          const status = deriveStatus(asset);
          const overdue = isOverdue(asset, today);
          return (
            <li key={asset.id}>
              <Card className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-lg text-text">{asset.name}</h3>
                    {asset.identifier ? (
                      <p className="text-xs text-text-muted">{asset.identifier}</p>
                    ) : null}
                  </div>
                  <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
                  <dt>Type</dt>
                  <dd className="text-text">{typeLabel(asset.type)}</dd>
                  <dt>Condition</dt>
                  <dd className="text-text">{conditionLabel(asset.condition)}</dd>
                  <dt>Held since</dt>
                  <dd className="text-text">{formatTimestamp(asset.assignedAt) ?? "—"}</dd>
                  <dt>Expected return</dt>
                  <dd className={overdue ? "text-rose-900 font-medium" : "text-text"}>
                    {formatShortDate(asset.expectedReturn) ?? "open-ended"}
                    {overdue ? " · overdue" : ""}
                  </dd>
                </dl>

                {asset.notes ? (
                  <p className="rounded-card bg-surface-subtle px-3 py-2 text-xs text-text-muted">
                    {asset.notes}
                  </p>
                ) : null}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Button
                    size="lg"
                    onClick={() => setConfirm({ asset, kind: "return" })}
                    disabled={isPending}
                  >
                    Return
                  </Button>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => setConfirm({ asset, kind: "check" })}
                    disabled={isPending}
                  >
                    Got it
                  </Button>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => setConfirm({ asset, kind: "damaged" })}
                    disabled={isPending || asset.condition === "damaged"}
                  >
                    Damaged
                  </Button>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => setConfirm({ asset, kind: "missing" })}
                    disabled={isPending || asset.condition === "missing"}
                  >
                    Missing
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {confirm ? (
        <ConfirmActionSheet
          confirm={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={runAction}
          isPending={isPending}
        />
      ) : null}
    </div>
  );
}

function ConfirmActionSheet({
  confirm,
  onCancel,
  onConfirm,
  isPending,
}: {
  confirm: NonNullable<ConfirmAction>;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const { asset, kind } = confirm;
  const copy = (() => {
    switch (kind) {
      case "return":
        return {
          title: "Return to depot?",
          body: `Logs ${asset.name} as returned. Admin can then re-assign or retire it.`,
          cta: "Return",
        };
      case "check":
        return {
          title: "Confirm in hand?",
          body: `Records that you've got ${asset.name} right now. No status change.`,
          cta: "Confirm",
        };
      case "damaged":
        return {
          title: "Report damaged?",
          body: `Flags ${asset.name} as damaged. Admin sees this on the register and decides next steps.`,
          cta: "Report damaged",
        };
      case "missing":
        return {
          title: "Report missing?",
          body: `Flags ${asset.name} as missing. Admin sees this on the register and decides next steps.`,
          cta: "Report missing",
        };
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40 p-3 sm:items-center"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-card bg-surface-raised p-5 shadow-raised"
      >
        <h2 className="font-display text-lg text-text">{copy.title}</h2>
        <p className="mt-2 text-sm text-text-muted">{copy.body}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" size="lg" onClick={onCancel} disabled={isPending} className="flex-1">
            Cancel
          </Button>
          <Button size="lg" onClick={onConfirm} disabled={isPending} className="flex-1">
            {isPending ? "Working…" : copy.cta}
          </Button>
        </div>
      </div>
    </div>
  );
}
