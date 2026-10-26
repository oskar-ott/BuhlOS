"use client";

import { useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { newOperationKey, undoMovement } from "@/domains/workshop-stock/client";
import { errorCopy } from "@/domains/workshop-stock/format";
import { isUncertain } from "@/domains/workshop-stock/pending";
import type { StockMovement, WriteResult } from "@/domains/workshop-stock/schema";
import { MiniButton, Slot } from "./ui";

/**
 * Undo one movement (Workshop Stock) — the one control every screen uses, so
 * the rules are the same everywhere:
 *
 *   • shown only when the server says this viewer may undo it (movement.undo)
 *   • the office must say why (undo.needsReason): the first tap asks for a
 *     short reason instead of failing with "reason required"
 *   • ONE operation key per movement until there's a definite answer: a tap
 *     after "not sure it went through" re-sends the same key and the server
 *     replays — it can never record a second undo
 *
 * It sits on the movement it undoes (a receipt, a history row), never beside
 * the doors.
 */
export function UndoControl({
  movement,
  onUndone,
  size = "lg",
  label = "Undo",
  testId = "stock-undo",
}: {
  movement: Pick<StockMovement, "id" | "undo">;
  onUndone: (r: WriteResult) => void;
  size?: "lg" | "sm" | "mini";
  label?: string;
  testId?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "asking" | "undoing">("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const needsReason = movement.undo?.needsReason === true;

  if (!movement.undo?.allowed) return null;

  async function send() {
    if (needsReason && reason.trim().length < 3) return;
    setPhase("undoing");
    setError(null);
    const key = keyRef.current ?? newOperationKey();
    keyRef.current = key;
    const r = await undoMovement({ movementId: movement.id, reason: needsReason ? reason.trim() : null }, key);
    if (r.ok) {
      keyRef.current = null;
      setPhase("idle");
      setReason("");
      onUndone(r.data);
      return;
    }
    const uncertain = isUncertain(r.error.status, r.error.body);
    if (!uncertain) keyRef.current = null;
    setPhase(needsReason ? "asking" : "idle");
    setError(uncertain ? "Not sure the undo went through — tap Undo again (it won't double up)." : errorCopy(r.error.status, r.error.body));
  }

  const asking = phase === "asking" || (needsReason && phase === "undoing");

  if (asking) {
    return (
      <div className="w-full space-y-2" data-testid={`${testId}-reason-form`}>
        <label className="block">
          <span className="text-sm font-semibold text-text">Why undo it? <span className="font-normal text-text-muted">(the office records a reason)</span></span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wrong item picked"
            maxLength={200}
            autoFocus
            disabled={phase === "undoing"}
            className="mt-1 h-12 w-full rounded-xl border border-border-strong bg-surface px-3 text-base text-text"
            data-testid={`${testId}-reason`}
          />
        </label>
        <div className="flex gap-2">
          <MiniButton variant="nav" onClick={() => void send()} disabled={phase === "undoing" || reason.trim().length < 3} data-testid={`${testId}-confirm`}>
            {phase === "undoing" ? "Undoing…" : "Undo it"}
          </MiniButton>
          <MiniButton onClick={() => { setPhase("idle"); setError(null); }} disabled={phase === "undoing"}>
            Keep it
          </MiniButton>
        </div>
        {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
      </div>
    );
  }

  const start = () => (needsReason ? setPhase("asking") : void send());
  const text = phase === "undoing" ? "Undoing…" : label;

  if (size === "mini") {
    return (
      <div className="flex flex-col items-end gap-1">
        <MiniButton onClick={start} disabled={phase === "undoing"} data-testid={testId}>
          <Undo2 aria-hidden="true" className="h-4 w-4" /> {text}
        </MiniButton>
        {error ? <p role="alert" className="max-w-[200px] text-right text-xs text-state-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className={size === "lg" ? "space-y-2" : "space-y-1"}>
      <button
        type="button"
        onClick={start}
        disabled={phase === "undoing"}
        className={cn(
          "flex items-center justify-center gap-2 rounded-[14px] border-2 border-brand-navy bg-surface font-display font-bold text-brand-navy disabled:opacity-60",
          size === "lg" ? "min-h-[56px] w-full px-4 text-[17px]" : "ml-auto min-h-[44px] w-fit px-3 text-sm",
        )}
        data-testid={testId}
      >
        <Undo2 aria-hidden="true" className="h-4 w-4" /> {text}
      </button>
      {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
    </div>
  );
}
