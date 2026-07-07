"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { PhilNotice } from "./ui/PhilNotice";
import { PhilStatusBadge, type PhilStatusTone } from "./ui/PhilStatusBadge";
import {
  AssetHistoryToggle,
  ConfirmActionSheet,
  HandOverSheet,
  type ConfirmAction,
} from "./PhilGearList";
import { listGear, reportGear, respondToTransfer, transferGear } from "@/domains/gear/client";
import {
  buildReturnToDepotPayload,
  deriveStatus,
  statusTone,
} from "@/domains/gear/service";
import {
  calibrationFlag,
  conditionLabel,
  formatShortDate,
  formatTimestamp,
  isOverdue,
  statusLabel,
} from "@/domains/gear/format";
import type { GearAsset } from "@/domains/gear/types";
import { cn } from "@/lib/cn";

/**
 * Phil Gear — sharpened re-skin (phil_sharpened, dark; Wave 2c of the
 * field-surface redesign). "Practical, not asset-management."
 *
 * Rendered ONLY when the server-resolved flag is on
 * (src/app/phil/gear/page.tsx branches; flag off = the current PhilGearList
 * screen, byte-identical). A restyled projection of the same real data —
 * behaviour preserved, not rebuilt:
 *
 *   - "Needs sorting · n" (red left rule) is derived from what the current
 *     list already derives: incoming handovers awaiting your accept (#306),
 *     expired / near-due calibrations (#305 calibrationFlag), and overdue
 *     expected returns (isOverdue). Nothing else qualifies — no invented
 *     urgency (P7).
 *   - "Scan a tag" is OMITTED: no field scan path exists in the repo (the
 *     current screen says so via its under-construction panel, which the
 *     page keeps below). Honest absence, not a dead button.
 *   - "Your gear" cards keep EVERY existing capability — Return, Got it,
 *     Hand over, Damaged, Missing, the on-demand history — via the SAME
 *     confirm/hand-over sheets (exported from PhilGearList, same testids)
 *     and the same non-optimistic domain client writes.
 *   - "On loan" holds the honestly-loan-shaped subset: assets the register
 *     really marks `ownership: "hired"` (supplier + hire end when set).
 *     There is no test/tag date on an asset ("Tagged · Aug" has no data
 *     source — tags are a per-job register), so the state line shows what
 *     IS real: held-since, condition, expected return, calibration.
 *   - A page-level "Report faulty gear" button is omitted: reporting is
 *     per-asset (the Damaged/Missing actions on each card ARE the existing
 *     report-condition flow); a floating variant would need an asset picker
 *     that doesn't exist today.
 */

interface Props {
  initialAssets: ReadonlyArray<GearAsset>;
  /** The logged-in worker — splits incoming handovers from held gear. */
  viewerId: string;
}

// gear-domain tone vocabulary → the sharpened badge tones (same words).
const GEAR_BADGE_TONE: Record<ReturnType<typeof statusTone>, PhilStatusTone> = {
  success: "success",
  info: "info",
  danger: "danger",
  warning: "warning",
  neutral: "neutral",
};

function SectionLabel({
  children,
  danger = false,
  id,
}: {
  children: string;
  danger?: boolean;
  id?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "px-1 font-display text-[12px] font-bold uppercase tracking-[0.09em]",
        danger ? "text-state-danger" : "text-text-muted",
      )}
    >
      {children}
    </h2>
  );
}

/** The asset-ref chip (e.g. a serial / asset code) — only when one is real. */
function AssetRef({ identifier }: { identifier: string }) {
  return (
    <span className="font-display text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted [font-variant-numeric:tabular-nums]">
      {identifier}
    </span>
  );
}

export function PhilGearSharpened({ initialAssets, viewerId }: Props) {
  const router = useRouter();
  const [assets, setAssets] = useState<ReadonlyArray<GearAsset>>(initialAssets);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [handover, setHandover] = useState<GearAsset | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  // Same action machinery as PhilGearList — the writes go through the same
  // domain client (non-optimistic: state changes only on a confirmed reply).
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
  // "On loan" = the register's REAL loan shape: hired gear. Everything else
  // held stays under "Your gear".
  const onLoan = held.filter((a) => a.ownership === "hired");
  const yourGear = held.filter((a) => a.ownership !== "hired");

  // Needs sorting — real urgent conditions only.
  const calibrationIssues = held.filter((a) => calibrationFlag(a, today) !== null);
  const overdueReturns = held.filter((a) => isOverdue(a, today));
  const needsSortingCount = incoming.length + calibrationIssues.length + overdueReturns.length;

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
              : `Reported ${asset.name} as missing`,
      );
      await refresh();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4" data-testid="phil-gear-sharpened">
      {/* Header: title + real count. No "Scan a tag" — no scan path exists. */}
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-text">
          Gear
        </h1>
        {held.length > 0 ? (
          <span className="font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted">
            {held.length} {held.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </header>

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

      {needsSortingCount > 0 ? (
        <section aria-labelledby="phil-gear-needs-sorting-heading" className="space-y-1.5">
          <SectionLabel id="phil-gear-needs-sorting-heading" danger>
            {`Needs sorting · ${needsSortingCount}`}
          </SectionLabel>
          <div
            data-testid="phil-gear-needs-sorting"
            className="space-y-2 rounded-card border border-border border-l-[5px] border-l-state-danger bg-surface-raised p-3 shadow-card"
          >
            {incoming.map((asset) => (
              <IncomingHandoverRow
                key={`in-${asset.id}`}
                asset={asset}
                isPending={isPending}
                onRespond={respond}
              />
            ))}
            {calibrationIssues.map((asset) => {
              const flag = calibrationFlag(asset, today)!;
              return (
                <div
                  key={`cal-${asset.id}`}
                  className="flex min-h-[44px] items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-baseline gap-2 text-sm font-semibold text-text">
                      <span className="truncate">{asset.name}</span>
                      {asset.identifier ? <AssetRef identifier={asset.identifier} /> : null}
                    </p>
                    <p className="mt-0.5 text-[13px] text-text-muted">
                      {flag.status === "expired"
                        ? `Calibration expired ${formatShortDate(asset.calibrationDue)} — don't test with it`
                        : `Calibration due ${formatShortDate(asset.calibrationDue)}${flag.daysToExpiry === 0 ? " — today" : ` — in ${flag.daysToExpiry}d`}`}
                    </p>
                  </div>
                  <PhilStatusBadge
                    label={flag.status === "expired" ? "Expired" : "Due soon"}
                    tone={flag.status === "expired" ? "danger" : "warning"}
                    className="shrink-0"
                  />
                </div>
              );
            })}
            {overdueReturns.map((asset) => (
              <div
                key={`due-${asset.id}`}
                className="flex min-h-[44px] items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2 text-sm font-semibold text-text">
                    <span className="truncate">{asset.name}</span>
                    {asset.identifier ? <AssetRef identifier={asset.identifier} /> : null}
                  </p>
                  <p className="mt-0.5 text-[13px] text-text-muted">
                    Was due back {formatShortDate(asset.expectedReturn)} — return it or ask for
                    longer
                  </p>
                </div>
                <PhilStatusBadge label="Overdue" tone="danger" className="shrink-0" />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {yourGear.length > 0 ? (
        <section aria-labelledby="phil-gear-yours-heading" className="space-y-1.5">
          <SectionLabel id="phil-gear-yours-heading">
            {`Your gear · ${yourGear.length}`}
          </SectionLabel>
          <ul className="space-y-2">
            {yourGear.map((asset) => (
              <li key={asset.id}>
                <SharpAssetCard
                  asset={asset}
                  today={today}
                  isPending={isPending}
                  onConfirm={setConfirm}
                  onHandover={setHandover}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {onLoan.length > 0 ? (
        <section aria-labelledby="phil-gear-on-loan-heading" className="space-y-1.5">
          <SectionLabel id="phil-gear-on-loan-heading">On loan</SectionLabel>
          <ul className="space-y-2">
            {onLoan.map((asset) => (
              <li key={asset.id}>
                <SharpAssetCard
                  asset={asset}
                  today={today}
                  isPending={isPending}
                  onConfirm={setConfirm}
                  onHandover={setHandover}
                  loan
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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

/* ── Incoming handover — the accept/decline prompt (capability preserved) ── */

function IncomingHandoverRow({
  asset,
  isPending,
  onRespond,
}: {
  asset: GearAsset;
  isPending: boolean;
  onRespond: (asset: GearAsset, accept: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-text">
        <span className="font-medium">{asset.pendingTransfer?.fromUserName ?? "A workmate"}</span>{" "}
        wants to hand you <span className="font-medium">{asset.name}</span>
        {asset.identifier ? ` · ${asset.identifier}` : ""}
      </p>
      {asset.pendingTransfer?.note ? (
        <p className="text-[13px] text-text-muted">“{asset.pendingTransfer.note}”</p>
      ) : null}
      <p className="text-[13px] text-text-muted">
        You&rsquo;re not responsible for it until you accept.
      </p>
      <div className="flex gap-2">
        <Button
          size="lg"
          className="flex-1"
          disabled={isPending}
          onClick={() => onRespond(asset, true)}
          data-testid="handover-accept"
        >
          Accept
        </Button>
        <Button
          size="lg"
          variant="secondary"
          className="flex-1"
          disabled={isPending}
          onClick={() => onRespond(asset, false)}
          data-testid="handover-decline"
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

/* ── One held asset, sharpened — real state line + the full action set ──── */

function SharpAssetCard({
  asset,
  today,
  isPending,
  onConfirm,
  onHandover,
  loan = false,
}: {
  asset: GearAsset;
  today: string;
  isPending: boolean;
  onConfirm: (c: ConfirmAction) => void;
  onHandover: (a: GearAsset) => void;
  loan?: boolean;
}) {
  const status = deriveStatus(asset);
  const overdue = isOverdue(asset, today);
  const calibration = calibrationFlag(asset, today);

  // The honest state line: only facts the register really has.
  const stateBits: string[] = [];
  const heldSince = formatTimestamp(asset.assignedAt);
  if (loan && asset.hireSupplier) stateBits.push(`From ${asset.hireSupplier}`);
  if (heldSince) stateBits.push(`Held since ${heldSince}`);
  if (asset.condition && asset.condition !== "good") {
    stateBits.push(conditionLabel(asset.condition));
  }
  const dueBack = formatShortDate(asset.expectedReturn);
  if (dueBack) stateBits.push(overdue ? `Due back ${dueBack} · overdue` : `Due back ${dueBack}`);
  const hireEnd = formatShortDate(asset.hireEndDate);
  if (loan && hireEnd) stateBits.push(`Hire ends ${hireEnd}`);

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-raised p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[17px] font-bold tracking-[-0.014em] text-text">
            {asset.name}
          </h3>
          {asset.identifier ? (
            <p className="mt-0.5">
              <AssetRef identifier={asset.identifier} />
            </p>
          ) : null}
        </div>
        <PhilStatusBadge
          label={statusLabel(status)}
          tone={GEAR_BADGE_TONE[statusTone(status)]}
          className="shrink-0"
        />
      </div>

      {stateBits.length > 0 ? (
        <p className={cn("text-[13px]", overdue ? "font-medium text-state-danger" : "text-text-muted")}>
          {stateBits.join(" · ")}
        </p>
      ) : null}

      {calibration ? (
        <PhilNotice tone={calibration.status === "expired" ? "danger" : "warning"} role="status">
          {calibration.status === "expired"
            ? `Calibration expired ${formatShortDate(asset.calibrationDue)} — don't test with this until it's recalibrated.`
            : `Calibration due ${formatShortDate(asset.calibrationDue)} (${calibration.daysToExpiry === 0 ? "today" : `in ${calibration.daysToExpiry}d`}).`}
        </PhilNotice>
      ) : null}

      {asset.notes ? (
        <p className="rounded-card bg-surface-subtle px-3 py-2 text-[13px] text-text-muted">
          {asset.notes}
        </p>
      ) : null}

      {asset.pendingTransfer ? (
        <PhilNotice tone="info" role="status">
          Waiting for {asset.pendingTransfer.toUserName ?? "a workmate"} to accept this handover —
          it&rsquo;s still yours until they do.
        </PhilNotice>
      ) : null}

      <AssetHistoryToggle assetId={asset.id} />

      {/* The full existing action set — same handlers, same confirm sheets.
          Damaged/Missing ARE the report-condition ("report faulty") flow. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button size="lg" onClick={() => onConfirm({ asset, kind: "return" })} disabled={isPending}>
          Return
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => onConfirm({ asset, kind: "check" })}
          disabled={isPending}
        >
          Got it
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => onHandover(asset)}
          disabled={isPending || Boolean(asset.pendingTransfer)}
          data-testid="handover-open"
        >
          Hand over
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => onConfirm({ asset, kind: "damaged" })}
          disabled={isPending || asset.condition === "damaged"}
        >
          Damaged
        </Button>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => onConfirm({ asset, kind: "missing" })}
          disabled={isPending || asset.condition === "missing"}
        >
          Missing
        </Button>
      </div>
    </div>
  );
}
