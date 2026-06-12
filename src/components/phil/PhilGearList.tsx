"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import { getGearDetail, listGear, listGearHolders, reportGear, respondToTransfer, transferGear } from "@/domains/gear/client";
import { buildReturnToDepotPayload, deriveStatus, statusTone } from "@/domains/gear/service";
import {
  calibrationFlag,
  conditionLabel,
  formatShortDate,
  formatTimestamp,
  historyKindLabel,
  isOverdue,
  statusLabel,
  typeLabel,
} from "@/domains/gear/format";
import type { GearAsset, GearHistoryEntry, ReportKind } from "@/domains/gear/types";

interface Props {
  initialAssets: ReadonlyArray<GearAsset>;
  /** The logged-in worker — splits incoming handovers from held gear (#306). */
  viewerId: string;
}

type ConfirmAction = {
  asset: GearAsset;
  kind: "return" | ReportKind;
} | null;

export function PhilGearList({ initialAssets, viewerId }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<ReadonlyArray<GearAsset>>(initialAssets);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [handover, setHandover] = useState<GearAsset | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  async function refresh() {
    const result = await listGear();
    if (result.ok) {
      setAssets(
        result.data.assets.filter(
          (a) => a.currentHolderId || a.pendingTransfer?.toUserId === viewerId,
        ),
      );
    }
  }

  const incoming = assets.filter(
    (a) => a.pendingTransfer?.toUserId === viewerId && a.currentHolderId !== viewerId,
  );
  const held = assets.filter((a) => a.currentHolderId === viewerId);

  function respond(asset: GearAsset, accept: boolean) {
    setErrorMessage(null);
    setSuccessMessage(null);
    startTransition(async () => {
      const result = await respondToTransfer(asset.id, accept);
      if (!result.ok) {
        setErrorMessage(result.error.message);
        return;
      }
      setSuccessMessage(accept ? `${asset.name} is now yours` : `Declined ${asset.name}`);
      await refresh();
      router.refresh();
    });
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
        <PhilNotice tone="danger" role="alert">
          {errorMessage}
        </PhilNotice>
      ) : null}
      {successMessage ? (
        <PhilNotice tone="success" role="status">
          {successMessage}
        </PhilNotice>
      ) : null}

      {incoming.length > 0 ? (
        <section aria-label="Handovers waiting on you" className="space-y-2">
          {incoming.map((asset) => (
            <Card key={asset.id} className="space-y-2 border-l-4 border-l-state-warning">
              <p className="text-sm text-text">
                <span className="font-medium">{asset.pendingTransfer?.fromUserName ?? "A workmate"}</span>{" "}
                wants to hand you <span className="font-medium">{asset.name}</span>
                {asset.identifier ? ` · ${asset.identifier}` : ""}
              </p>
              {asset.pendingTransfer?.note ? (
                <p className="text-xs text-text-muted">“{asset.pendingTransfer.note}”</p>
              ) : null}
              <p className="text-xs text-text-muted">
                You&rsquo;re not responsible for it until you accept.
              </p>
              <div className="flex gap-2">
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={isPending}
                  onClick={() => respond(asset, true)}
                  data-testid="handover-accept"
                >
                  Accept
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  className="flex-1"
                  disabled={isPending}
                  onClick={() => respond(asset, false)}
                  data-testid="handover-decline"
                >
                  Decline
                </Button>
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      <ul className="space-y-3">
        {held.map((asset) => {
          const status = deriveStatus(asset);
          const overdue = isOverdue(asset, today);
          const calibration = calibrationFlag(asset, today);
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

                {calibration ? (
                  <PhilNotice
                    tone={calibration.status === "expired" ? "danger" : "warning"}
                    role="status"
                  >
                    {calibration.status === "expired"
                      ? `Calibration expired ${formatShortDate(asset.calibrationDue)} — don't test with this until it's recalibrated.`
                      : `Calibration due ${formatShortDate(asset.calibrationDue)} (${calibration.daysToExpiry === 0 ? "today" : `in ${calibration.daysToExpiry}d`}).`}
                  </PhilNotice>
                ) : null}

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
                  <dt>Type</dt>
                  <dd className="text-text">{typeLabel(asset.type)}</dd>
                  <dt>Condition</dt>
                  <dd className="text-text">{conditionLabel(asset.condition)}</dd>
                  <dt>Held since</dt>
                  <dd className="text-text">{formatTimestamp(asset.assignedAt) ?? "—"}</dd>
                  <dt>Expected return</dt>
                  <dd className={overdue ? "font-medium text-state-danger" : "text-text"}>
                    {formatShortDate(asset.expectedReturn) ?? "open-ended"}
                    {overdue ? " · overdue" : ""}
                  </dd>
                </dl>

                {asset.notes ? (
                  <p className="rounded-card bg-surface-subtle px-3 py-2 text-xs text-text-muted">
                    {asset.notes}
                  </p>
                ) : null}

                {asset.pendingTransfer ? (
                  <PhilNotice tone="info" role="status">
                    Waiting for {asset.pendingTransfer.toUserName ?? "a workmate"} to accept this
                    handover — it&rsquo;s still yours until they do.
                  </PhilNotice>
                ) : null}

                <AssetHistoryToggle assetId={asset.id} />

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
                    onClick={() => setHandover(asset)}
                    disabled={isPending || Boolean(asset.pendingTransfer)}
                    data-testid="handover-open"
                  >
                    Hand over
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

      {handover ? (
        <HandOverSheet
          asset={handover}
          viewerId={viewerId}
          isPending={isPending}
          onClose={() => setHandover(null)}
          onPropose={(toUserId) => {
            const asset = handover;
            setHandover(null);
            setErrorMessage(null);
            setSuccessMessage(null);
            startTransition(async () => {
              const result = await transferGear({ assetId: asset.id, toUserId });
              if (!result.ok) {
                setErrorMessage(result.error.message);
                return;
              }
              setSuccessMessage(
                "Handover proposed — it stays your responsibility until they accept.",
              );
              await refresh();
              router.refresh();
            });
          }}
        />
      ) : null}

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

function HandOverSheet({
  asset,
  viewerId,
  isPending,
  onClose,
  onPropose,
}: {
  asset: GearAsset;
  viewerId: string;
  isPending: boolean;
  onClose: () => void;
  onPropose: (toUserId: string) => void;
}) {
  const [workmates, setWorkmates] = useState<Array<{ id: string; username: string }> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toUserId, setToUserId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listGearHolders().then((result) => {
      if (cancelled) return;
      if (result.ok) setWorkmates(result.data.users.filter((u) => u.id !== viewerId));
      else setLoadError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hand over"
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-card bg-surface-raised p-5 shadow-raised"
      >
        <h2 className="font-display text-lg text-text">Hand over {asset.name}</h2>
        <p className="text-sm text-text-muted">
          They get a ping and accept it in their gear list. It stays YOUR responsibility until
          they do — declines and 5-day timeouts hand it straight back.
        </p>
        {loadError ? (
          <p className="text-sm text-state-danger" role="alert">
            Couldn&rsquo;t load your workmates: {loadError}
          </p>
        ) : workmates === null ? (
          <p className="text-sm text-text-muted" role="status">
            Loading workmates…
          </p>
        ) : (
          <select
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            className="h-12 w-full rounded-card border border-border bg-surface px-3 text-base"
            aria-label="Hand over to"
            data-testid="handover-picker"
          >
            <option value="">— Pick a workmate —</option>
            {workmates.map((w) => (
              <option key={w.id} value={w.id}>
                {w.username}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" size="lg" className="flex-1" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={isPending || !toUserId}
            onClick={() => onPropose(toUserId)}
            data-testid="handover-propose"
          >
            Propose handover
          </Button>
        </div>
      </div>
    </div>
  );
}

/** #306: the asset's full transfer/report/handshake timeline, loaded on
 *  demand from the same per-asset history blob the admin drawer reads. */
function AssetHistoryToggle({ assetId }: { assetId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ReadonlyArray<GearHistoryEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entries === null) {
      void getGearDetail(assetId).then((result) => {
        if (result.ok) setEntries(result.data.history);
        else setError(result.error.message);
      });
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="text-xs text-text-muted underline underline-offset-2"
        data-testid="asset-history-toggle"
      >
        {open ? "Hide history" : "History"}
      </button>
      {open ? (
        error ? (
          <p className="mt-1 text-xs text-state-danger">Couldn&rsquo;t load history: {error}</p>
        ) : entries === null ? (
          <p className="mt-1 text-xs text-text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">No history yet.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-text-muted">
            {entries.map((e) => (
              <li key={e.id}>
                <span className="font-medium text-text">{historyKindLabel(e.kind)}</span>
                {" · "}
                {formatTimestamp(e.at) ?? "—"}
                {e.byName ? ` · by ${e.byName}` : ""}
                {e.note ? ` — ${e.note}` : ""}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
