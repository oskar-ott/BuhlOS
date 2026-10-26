"use client";

import type { ReactNode } from "react";
import { movementSummary, recordedNow, undoLabelFor, undoUntilLabel } from "@/domains/workshop-stock/format";
import type { WriteResult } from "@/domains/workshop-stock/schema";
import { Slot } from "./ui";
import { UndoControl } from "./UndoControl";

/**
 * The receipt (Workshop Stock): what was just written, in the ledger's words —
 * "Taken 2 each · Clipsal double GPO white", the quantity recorded now and
 * where, how long it can be undone, and the Undo itself on the receipt (never
 * by the doors). After an undo the same card reads "Undone (+2 each)".
 */
export function StockReceipt({
  result,
  undone,
  onUndone,
  title,
  note,
  testId,
  balanceTestId,
  undoTestId = "stock-receipt-undo",
  className,
}: {
  result: WriteResult;
  /** the reversal, once the receipt's Undo was used */
  undone?: WriteResult | null;
  onUndone?: (r: WriteResult) => void;
  /** overrides the first line ("Your save went through") */
  title?: ReactNode;
  /** an extra line (a photo that couldn't be attached) */
  note?: ReactNode;
  testId?: string;
  balanceTestId?: string;
  undoTestId?: string;
  className?: string;
}) {
  const m = result.movement;
  const item = undone ? undone.item : result.item;
  const unit = result.item.baseUnit;
  const heading = title ?? (undone ? `${movementSummary(undone.movement, unit)} · ${result.item.name}` : `${movementSummary(m, unit)} · ${result.item.name}`);
  const until = undone ? null : undoUntilLabel(m.undo);
  const canUndo = !undone && m.kind !== "reversal" && Boolean(m.undo?.allowed) && onUndone;
  return (
    <Slot
      tone="ok"
      title={heading}
      className={className}
      testId={testId}
      action={canUndo ? <UndoControl movement={m} size="mini" label={undoLabelFor(m.kind)} onUndone={onUndone} testId={undoTestId} /> : null}
    >
      <p>
        <span data-testid={balanceTestId}>
          {recordedNow(item)}
          {result.replayed && !undone ? " (already saved earlier)" : ""}
        </span>
        {item.location ? ` · ${item.location}` : ""}
      </p>
      {until ? <p className="text-[13px] text-text-muted">{until}</p> : null}
      {note ? <p className="text-[13px] text-text-muted">{note}</p> : null}
    </Slot>
  );
}
