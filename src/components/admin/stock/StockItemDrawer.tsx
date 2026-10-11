"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { PhotoCapture } from "@/components/stock/PhotoCapture";
import { StockThumb } from "@/components/stock/StockThumb";
import { fetchHistory, fetchItem, newOperationKey, replaceItemPhoto, setArchived, storePhoto, undoMovement } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, identityLine, movementSummary, signedQuantity, timeAgo } from "@/domains/workshop-stock/format";
import { isUncertain } from "@/domains/workshop-stock/pending";
import type { ItemDetail, StockMovement } from "@/domains/workshop-stock/schema";
import { CheckSection, CountForm, EditForm, IdentifiersEditor } from "./StockAdminForms";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="font-display text-sm font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Added to the catalogue", updated: "Details edited", archived: "Archived", restored: "Restored",
  identifier_added: "Code added", identifier_removed: "Code removed", photo_changed: "Photo changed", verification_recorded: "Online check recorded",
};

/**
 * The office view of one workshop item: recorded balance, count correction,
 * the full movement history with audited Undo, then catalogue details, codes,
 * online check, photo, and — set apart at the bottom — archive/restore (P12:
 * the destructive action never sits beside routine ones). An archived item is
 * read-only until it is restored.
 */
export function StockItemDrawer({ itemId, lookupEnabled, onClose, onChanged }: { itemId: string; lookupEnabled: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [older, setOlder] = useState<StockMovement[]>([]);
  const [next, setNext] = useState<{ before: string; beforeId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  // one operation key per movement until its undo has a definite answer
  const undoKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    const r = await fetchItem(itemId);
    if (r.ok) { setDetail(r.data); setOlder([]); setNext(r.data.movements.length >= 50 ? { before: r.data.movements[r.data.movements.length - 1]!.createdAt ?? "", beforeId: r.data.movements[r.data.movements.length - 1]!.id } : null); setError(null); }
    else setError(errorCopy(r.error.status, r.error.body, "Couldn't load this item."));
  }, [itemId]);
  useEffect(() => { void load(); }, [load]);

  function changed() { onChanged(); void load(); }

  async function loadOlder() {
    if (!next) return;
    const r = await fetchHistory(itemId, next);
    if (r.ok) { setOlder((o) => [...o, ...r.data.movements]); setNext(r.data.next); }
  }

  async function undo(m: StockMovement) {
    setBusy(true); setError(null);
    const key = undoKeys.current.get(m.id) ?? newOperationKey();
    undoKeys.current.set(m.id, key);
    const r = await undoMovement({ movementId: m.id, reason: undoReason.trim() }, key);
    setBusy(false);
    if (r.ok) { undoKeys.current.delete(m.id); setUndoFor(null); setUndoReason(""); changed(); return; }
    if (isUncertain(r.error.status, r.error.body)) {
      setError("Not sure the undo went through — try again (it won't double up).");
      return;
    }
    undoKeys.current.delete(m.id);
    setError(errorCopy(r.error.status, r.error.body));
  }

  async function archive(archived: boolean) {
    setBusy(true); setError(null); setRestoreNote(null);
    const r = await setArchived(itemId, archived);
    setBusy(false);
    setConfirmArchive(false);
    if (!r.ok) { setError(errorCopy(r.error.status, r.error.body)); return; }
    const kept = r.data.codesNotRestored ?? [];
    if (kept.length) {
      setRestoreNote(`Restored without ${kept.map((c) => `${c.value}${c.heldBy ? ` (now on “${c.heldBy}”)` : ""}`).join(", ")} — another item uses ${kept.length === 1 ? "that code" : "those codes"} now.`);
    }
    changed();
  }

  async function newPhoto(dataUrl: string, thumbDataUrl: string | null) {
    setPhotoMsg("Saving photo…");
    const s = await storePhoto(dataUrl, thumbDataUrl);
    if (!s.ok) { setPhotoMsg(errorCopy(s.error.status, s.error.body)); return; }
    const r = await replaceItemPhoto(itemId, s.data.photoId);
    setPhotoMsg(r.ok ? "Photo changed." : errorCopy(r.error.status, r.error.body));
    if (r.ok) changed();
  }

  const item = detail?.item;
  const movements = [...(detail?.movements ?? []), ...older];
  const unitLocked = movements.some((m) => m.quantityMilli !== 0 || (m.countedMilli ?? 0) !== 0);

  return (
    <Drawer open onClose={onClose} title={item ? item.name : "Workshop item"} subtitle={item ? identityLine(item) || undefined : undefined}>
      {!item ? (
        <p className="text-sm text-text-muted">{error ?? "Loading…"}</p>
      ) : (
        <div className="space-y-4" data-testid="stock-drawer">
          <div className="flex gap-3">
            <StockThumb photoId={item.photoId} alt={item.name} size="lg" />
            <div className="space-y-1 text-sm">
              <p className="font-display text-2xl font-semibold text-text" data-testid="stock-drawer-balance">{balanceLabel(item)}</p>
              <p className="text-text-muted">Recorded — not a guarantee of what&rsquo;s on the shelf.</p>
              <p className="text-text">Location: {item.location || "not set"}</p>
              <p className="text-text-muted">Last movement {timeAgo(item.lastMovementAt)} · last counted {item.lastCountedAt ? `${timeAgo(item.lastCountedAt)}${item.lastCountedByName ? ` by ${item.lastCountedByName}` : ""}` : "never"}</p>
              {item.archivedAt ? <p className="font-semibold text-state-warning">Archived {timeAgo(item.archivedAt)}</p> : null}
            </div>
          </div>
          {error ? <p role="alert" className="text-sm text-state-danger">{error}</p> : null}
          {restoreNote ? <p role="status" className="text-sm text-state-warning" data-testid="stock-restore-note">{restoreNote}</p> : null}

          <Section title="Correct the count"><CountForm item={item} onSaved={changed} /></Section>
          <Section title="Movement history">
            <ul className="space-y-1.5" data-testid="stock-history">
              {movements.map((m) => (
                <li key={m.id} className="rounded-[4px] border border-border px-2 py-1.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={m.reversedBy ? "text-text-muted line-through" : "text-text"}>
                        {movementSummary(m, item.baseUnit)} <span className="text-text-muted">({signedQuantity(m.quantityMilli, item.baseUnit)} → {formatQuantity(m.balanceAfterMilli, item.baseUnit)})</span>
                      </p>
                      <p className="text-xs text-text-muted">
                        {[m.actorName, m.createdAt ? new Date(m.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null, m.jobLabel ? `job ${m.jobLabel}` : null, m.estimated ? "estimate" : null].filter(Boolean).join(" · ")}
                      </p>
                      {m.reason || m.note ? <p className="text-xs text-text">{m.reason || m.note}</p> : null}
                      {m.reversedBy ? <p className="text-xs text-text-muted">Undone by {m.reversedBy.actorName ?? "someone"} {timeAgo(m.reversedBy.at)}{m.reversedBy.reason ? ` — ${m.reversedBy.reason}` : ""}</p> : null}
                    </div>
                    {m.undo?.allowed && undoFor !== m.id ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setUndoFor(m.id); setUndoReason(""); }} data-testid="stock-history-undo">Undo</Button>
                    ) : null}
                  </div>
                  {undoFor === m.id ? (
                    <div className="mt-2 flex gap-2">
                      <input value={undoReason} onChange={(e) => setUndoReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason for undo" className="h-9 min-w-0 flex-1 rounded-[4px] border border-border px-2 text-sm" data-testid="stock-history-undo-reason" />
                      <Button type="button" size="sm" onClick={() => void undo(m)} disabled={busy || undoReason.trim().length < 3} data-testid="stock-history-undo-confirm">Undo it</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setUndoFor(null)}>Cancel</Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {next ? <Button type="button" variant="secondary" size="sm" onClick={() => void loadOlder()}>Load older</Button> : null}
          </Section>
          {item.archivedAt ? (
            <Section title="Details">
              <p className="text-sm text-text-muted" data-testid="stock-drawer-archived-note">Archived — restore it (below) to change its details, codes, online check or photo.</p>
            </Section>
          ) : (
            <>
              {/* keyed on the item, not its revision: a reload never wipes what the office is typing */}
              <Section title="Details"><EditForm key={item.id} item={item} unitLocked={unitLocked} onSaved={changed} /></Section>
              <Section title="Codes, barcodes and packs"><IdentifiersEditor item={item} onChanged={changed} /></Section>
              <Section title="Online product check"><CheckSection item={item} lookupEnabled={lookupEnabled} onChanged={changed} /></Section>
              <Section title="Photo">
                <PhotoCapture guidance="Replace the product photo." onPhoto={(u, _d, t) => void newPhoto(u, t)} testId="stock-drawer-photo" />
                {photoMsg ? <p className="text-sm text-text-muted">{photoMsg}</p> : null}
              </Section>
            </>
          )}


          {detail?.events?.length ? (
            <Section title="Catalogue history">
              <ul className="space-y-1 text-xs text-text-muted">
                {detail.events.map((e) => (
                  <li key={e.id}>{EVENT_LABEL[e.event] ?? e.event} · {e.actorName ?? "someone"} · {timeAgo(e.at)}{e.event === "updated" && e.detail && typeof e.detail === "object" && "changes" in e.detail ? ` (${Object.keys(e.detail.changes as Record<string, unknown>).join(", ")})` : ""}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <section className="mt-6 space-y-2 rounded-card border border-state-danger-subtle-border p-3">
            <h3 className="font-display text-sm font-semibold text-text">{item.archivedAt ? "Restore" : "Archive"}</h3>
            <p className="text-xs text-text-muted">
              {item.archivedAt
                ? "Brings the item back to the lists. Its codes come back too, unless another item uses them now."
                : `Hides the item from the lists and frees its codes. History is kept.${item.balanceMilli ? ` ${balanceLabel(item)} is still recorded against it.` : ""}`}
            </p>
            {item.archivedAt ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => void archive(false)} disabled={busy} data-testid="stock-restore">Restore item</Button>
            ) : confirmArchive ? (
              <div className="flex gap-2">
                <Button type="button" variant="danger" size="sm" onClick={() => void archive(true)} disabled={busy} data-testid="stock-archive-confirm">Yes, archive it</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmArchive(false)}>Keep it</Button>
              </div>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmArchive(true)} data-testid="stock-archive">Archive item…</Button>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
