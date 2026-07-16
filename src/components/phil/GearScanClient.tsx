"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PhilNotice } from "./ui/PhilNotice";
import {
  buildReturnToDepotPayload,
  statusTone,
} from "@/domains/gear/service";
import { claimGear, reportGear, transferGear } from "@/domains/gear/client";
import { conditionLabel, statusLabel, typeLabel } from "@/domains/gear/format";
import type { ReportKind, ScanInfoResponse } from "@/domains/gear/types";

type ScanAsset = ScanInfoResponse["asset"];

interface Props {
  asset: ScanAsset;
  /** True when the viewer is an assignable holder (field / leading hand). */
  canClaim: boolean;
  viewerId: string;
}

/**
 * The scanned-tool experience (#303). Given the summary-only scan-info, show
 * the asset and the ONE right action for its state. One-handed, thumb-sized
 * buttons, site language — a scan is meant to end in a single tap.
 *
 * States:
 *   held-by-me    → Return + Got it / Damaged / Missing (the existing actions)
 *   in-storage    → Claim (assignable roles) / read-only note (admin/client)
 *   held-by-other → honest "held by <name>" + Request transfer (#306 handshake)
 *   retired       → "no longer in service"
 */
export function GearScanClient({ asset, canClaim, viewerId }: Props) {
  const router = useRouter();
  const [banner, setBanner] = useState<
    { tone: "success" | "danger" | "info"; text: string } | null
  >(null);
  const [isPending, startTransition] = useTransition();
  // Local optimistic copy so the card reflects a just-completed claim without a
  // full reload (the server row is the source of truth on next navigation).
  const [current, setCurrent] = useState<ScanAsset>(asset);

  const status = current.status;
  const heldByMe = current.heldByMe;
  const heldByOther = Boolean(current.currentHolderId) && !heldByMe;
  const inStorage = !current.currentHolderId && status !== "retired";
  const retired = status === "retired";

  function claim() {
    setBanner(null);
    startTransition(async () => {
      const result = await claimGear({ assetId: current.id });
      if (!result.ok) {
        setBanner({ tone: "danger", text: result.error.message });
        // A 409 means a holder appeared — refresh to show the honest new state.
        router.refresh();
        return;
      }
      setCurrent({
        ...current,
        status: "assigned",
        currentHolderId: viewerId,
        heldByMe: true,
      });
      setBanner({ tone: "success", text: `${current.name} is yours now.` });
      router.refresh();
    });
  }

  function heldAction(kind: "return" | ReportKind) {
    setBanner(null);
    startTransition(async () => {
      const result =
        kind === "return"
          ? await transferGear(buildReturnToDepotPayload({ id: current.id }))
          : await reportGear({ assetId: current.id, kind });
      if (!result.ok) {
        setBanner({ tone: "danger", text: result.error.message });
        return;
      }
      setBanner({
        tone: "success",
        text:
          kind === "return"
            ? `Returned ${current.name} to the depot.`
            : kind === "check"
              ? `Confirmed you’ve got ${current.name}.`
              : kind === "damaged"
                ? `Reported ${current.name} as damaged.`
                : `Reported ${current.name} as missing.`,
      });
      if (kind === "return") {
        setCurrent({ ...current, status: "available", currentHolderId: null, heldByMe: false });
      }
      router.refresh();
    });
  }

  function requestTransfer() {
    // Reuse the #306 handshake: proposing a transfer to yourself asks the
    // current holder to hand it over (it stays theirs until they accept).
    setBanner(null);
    startTransition(async () => {
      const result = await transferGear({ assetId: current.id, toUserId: viewerId });
      if (!result.ok) {
        setBanner({ tone: "danger", text: result.error.message });
        return;
      }
      setBanner({
        tone: "info",
        text: `Asked ${current.currentHolderName ?? "the holder"} to hand ${current.name} over. It’s theirs until they accept.`,
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {banner ? (
        <PhilNotice tone={banner.tone} role={banner.tone === "danger" ? "alert" : "status"}>
          {banner.text}
        </PhilNotice>
      ) : null}

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-xl text-text">{current.name}</h2>
            {current.identifier ? (
              <p className="text-xs text-text-muted">{current.identifier}</p>
            ) : null}
          </div>
          <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-muted">
          <dt>Type</dt>
          <dd className="text-text">{typeLabel(current.type)}</dd>
          <dt>Condition</dt>
          <dd className="text-text">{conditionLabel(current.condition)}</dd>
          <dt>Held by</dt>
          <dd className="text-text">
            {heldByMe ? "You" : current.currentHolderName ?? "In storage"}
          </dd>
        </dl>

        {/* ── The ONE right action per state ─────────────────────────── */}

        {retired ? (
          <PhilNotice tone="neutral" title="No longer in service" role="status">
            This tool has been retired. If it’s in your hands, drop it back at the
            depot and let the office know.
          </PhilNotice>
        ) : heldByMe ? (
          <HeldByMeActions isPending={isPending} onAction={heldAction} condition={current.condition} />
        ) : heldByOther ? (
          <div className="space-y-2">
            <PhilNotice tone="info" role="status">
              {current.currentHolderName ?? "A workmate"} is holding this right now.
            </PhilNotice>
            {current.pendingTransfer ? (
              <PhilNotice tone="neutral" role="status">
                A handover for this tool is already waiting on{" "}
                {current.pendingTransfer.toUserName ?? "someone"}.
              </PhilNotice>
            ) : canClaim ? (
              <Button
                size="lg"
                className="w-full"
                disabled={isPending}
                onClick={requestTransfer}
                data-testid="scan-request-transfer"
              >
                {isPending ? "Asking…" : "Ask them to hand it over"}
              </Button>
            ) : (
              <p className="text-xs text-text-muted">You can’t hold gear, so there’s nothing to do here.</p>
            )}
          </div>
        ) : inStorage ? (
          canClaim ? (
            <Button
              size="lg"
              className="w-full"
              disabled={isPending}
              onClick={claim}
              data-testid="scan-claim"
            >
              {isPending ? "Claiming…" : "Claim this tool"}
            </Button>
          ) : (
            <PhilNotice tone="neutral" role="status">
              This tool is in storage. Admin assigns gear from the office register —
              you’re seeing it read-only.
            </PhilNotice>
          )
        ) : null}
      </Card>
    </div>
  );
}

function HeldByMeActions({
  isPending,
  onAction,
  condition,
}: {
  isPending: boolean;
  onAction: (kind: "return" | ReportKind) => void;
  condition: ScanAsset["condition"];
}) {
  return (
    <div className="space-y-2">
      <Button
        size="lg"
        className="w-full"
        disabled={isPending}
        onClick={() => onAction("return")}
        data-testid="scan-return"
      >
        Return to depot
      </Button>
      <div className="grid grid-cols-3 gap-2">
        <Button
          size="lg"
          variant="secondary"
          disabled={isPending}
          onClick={() => onAction("check")}
          data-testid="scan-check"
        >
          Got it
        </Button>
        <Button
          size="lg"
          variant="secondary"
          disabled={isPending || condition === "damaged"}
          onClick={() => onAction("damaged")}
          data-testid="scan-damaged"
        >
          Damaged
        </Button>
        <Button
          size="lg"
          variant="secondary"
          disabled={isPending || condition === "missing"}
          onClick={() => onAction("missing")}
          data-testid="scan-missing"
        >
          Missing
        </Button>
      </div>
    </div>
  );
}
