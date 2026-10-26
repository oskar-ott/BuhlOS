"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { PhotoCapture } from "@/components/stock/PhotoCapture";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { fetchHistory, fetchItem, newOperationKey, replaceItemPhoto, setArchived, storePhoto, undoMovement } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, identityLine, movementSummary, movementWho, signedQuantity, undoLabelFor, whenLabel } from "@/domains/workshop-stock/format";
import { isUncertain } from "@/domains/workshop-stock/pending";
import type { ItemDetail, StockMovement } from "@/domains/workshop-stock/schema";
import { Block, CheckSection, CountForm, EditForm, IdentifiersEditor, INPUT, LABEL } from "./StockAdminForms";

/** The quiet mono section label with the yellow tick (the office card-label motif). */
function Kick({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text">
      <span aria-hidden="true" className="inline-block h-2 w-2 bg-accent-yellow" />
      {children}
    </p>
  );
}

function Section({ kicker, children, className }: { kicker: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2.5 border-b border-border pb-4", className)}>
      <Kick>{kicker}</Kick>
      {children}
    </section>
  );
}

function Fold({ label, sub, open, onClick, testId }: { label: string; sub?: ReactNode; open: boolean; onClick: () => void; testId?: string }) {
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <button type="button" onClick={onClick} aria-expanded={open} className="flex min-h-[44px] w-full items-center justify-between gap-3 border-b border-border py-2.5 text-left" data-testid={testId}>
      <span className="font-display text-[15px] font-semibold text-text">
        {label}
        {sub ? <span className="ml-1.5 font-sans text-[13px] font-normal text-text-muted">{sub}</span> : null}
      </span>
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
    </button>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Added to the catalogue", updated: "Details edited", archived: "Archived", restored: "Restored",
  identifier_added: "Code added", identifier_removed: "Code removed", photo_changed: "Photo changed", verification_recorded: "Online check recorded",
};

/**
 * The office view of one workshop item, ordered by use: what's recorded and
 * Correct the count first; then the movement history with its audited Undo
 * (a reason, written into the history); then the catalogue folded away
 * (details, codes and packs, the online check, the photo, its own history);
 * and archive last and apart (P12: the destructive action never sits beside
 * routine ones). An archived item is read-only until it is restored.
 */
export function StockItemDrawer({ itemId, lookupEnabled, onClose, onChanged }: { itemId: string; lookupEnabled: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [older, setOlder] = useState<StockMovement[]>([]);
  const [next, setNext] = useState<{ before: string; beforeId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
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
    setArchiveOpen(false);
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
  const unit = item?.baseUnit ?? "each";
  const lastMove = movements[0];

  const history = (
    <>
      <ul className="divide-y divide-border" data-testid="stock-history">
        {movements.map((m) => {
          const asking = undoFor === m.id;
          const undoQty = signedQuantity(-m.quantityMilli, unit);
          return (
            <li key={m.id} className="py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={cn("font-semibold", m.reversedBy ? "text-text-muted line-through" : "text-text")}>
                    {movementSummary(m, unit)} <span className="font-normal text-text-muted">· {formatQuantity(m.balanceAfterMilli, unit)} after</span>
                  </p>
                  <p className="text-xs text-text-muted">{movementWho(m)}{m.estimated ? " · estimate" : ""}</p>
                  {m.reason || m.note ? <p className="text-xs text-text">{m.reason || m.note}</p> : null}
                  {m.reversedBy ? <p className="text-xs text-text-muted">Undone by {m.reversedBy.actorName ?? "someone"} · {whenLabel(m.reversedBy.at)}{m.reversedBy.reason ? ` — ${m.reversedBy.reason}` : ""}</p> : null}
                </div>
                {m.undo?.allowed && !asking ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setUndoFor(m.id); setUndoReason(""); }} data-testid="stock-history-undo">Undo…</Button>
                ) : null}
              </div>
              {asking ? (
                <div className="mt-2 space-y-2 rounded-card border border-border bg-surface-subtle p-3" data-testid="stock-history-undo-form">
                  <label className="block">
                    <span className={LABEL}>{undoLabelFor(m.kind).replace("Undo", "Undo this")} — reason (required)</span>
                    <input value={undoReason} onChange={(e) => setUndoReason(e.target.value)} autoFocus placeholder="e.g. wrong roll taken" aria-label="Reason for undo" className={cn(INPUT, "mt-1")} data-testid="stock-history-undo-reason" />
                  </label>
                  <p className="text-xs text-text-muted">Writes Undone ({undoQty}). The {m.kind === "count" ? "count" : m.kind} stays in the history.</p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => void undo(m)} disabled={busy || undoReason.trim().length < 3} data-testid="stock-history-undo-confirm">{undoLabelFor(m.kind)} · {undoQty}</Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setUndoFor(null)}>Keep it</Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {detail && !movements.length ? <li className="py-2 text-sm text-text-muted">No movements yet.</li> : null}
      </ul>
      {next ? <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlder()}>Load older</Button> : null}
    </>
  );

  return (
    <Drawer open onClose={onClose} title={item ? item.name : "Workshop item"} subtitle={item ? [identityLine(item), item.location].filter(Boolean).join(" · ") || undefined : undefined}>
      {!item ? (
        <p className="text-sm text-text-muted">{error ?? "Loading…"}</p>
      ) : (
        <div className="space-y-4" data-testid="stock-drawer">
          {error ? <p role="alert" className="text-sm text-state-danger">{error}</p> : null}
          {restoreNote ? <p role="status" className="rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg p-2.5 text-sm text-text" data-testid="stock-restore-note">{restoreNote}</p> : null}

          {item.archivedAt ? (
            <>
              <Section kicker="Recorded when archived">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="neutral" dot>Archived</Pill>
                  <span className="text-xs text-text-muted">{whenLabel(item.archivedAt)} · read-only until restored</span>
                </div>
                <div className="flex items-center gap-3">
                  <StockThumb photoId={item.photoId} alt={item.name} size="lg" />
                  <p className="font-display text-[26px] font-semibold text-text" data-testid="stock-drawer-balance">{balanceLabel(item)}</p>
                </div>
                <p className="text-sm text-text-muted" data-testid="stock-drawer-archived-note">Counts, takes and edits are off while archived. Restore it (below) to change its details, codes, online check or photo.</p>
              </Section>
              <Section kicker="Movement history">{history}</Section>
              {item.identifiers.length ? (
                <Section kicker="Codes it had">
                  <ul className="divide-y divide-border text-sm">
                    {item.identifiers.map((i) => (
                      <li key={i.id} className="py-1.5 text-text"><span className="font-mono">{i.value}</span> · {i.kind === "manufacturer_code" ? "maker's code" : i.kind === "supplier_sku" ? "supplier SKU" : "barcode"}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}
              <Block tone="inf" title="Restore item" className="mt-2">
                <p>It comes back to the crew&rsquo;s list. Its codes come back unless another item uses them now — the restore says which.</p>
                <Button type="button" size="sm" className="mt-1" onClick={() => void archive(false)} disabled={busy} data-testid="stock-restore">Restore item</Button>
              </Block>
            </>
          ) : (
            <>
              <Section kicker="Recorded">
                <div className="flex items-center gap-3">
                  <StockThumb photoId={item.photoId} alt={item.name} size="lg" />
                  <div>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="font-display text-[26px] font-semibold leading-none text-text" data-testid="stock-drawer-balance">{balanceLabel(item).replace(" (estimate)", "")}</p>
                      {item.estimated ? <Pill tone="warning" dot>Estimate</Pill> : null}
                    </div>
                    <p className="mt-1 text-xs text-text-muted">Recorded — not a guarantee of what&rsquo;s on the shelf.</p>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className={LABEL}>Last counted</dt>
                    <dd className="text-text">{item.lastCountedAt ? `${whenLabel(item.lastCountedAt)}${item.lastCountedByName ? ` · ${item.lastCountedByName}` : ""}` : "Never"}</dd>
                  </div>
                  <div>
                    <dt className={LABEL}>Last movement</dt>
                    <dd className="text-text">{lastMove ? `${movementSummary(lastMove, unit)} · ${movementWho(lastMove)}` : "None yet"}</dd>
                  </div>
                </dl>
              </Section>

              <Section kicker="Correct the count"><CountForm key={item.id} item={item} onSaved={changed} /></Section>

              <Section kicker="Movement history">{history}</Section>

              <div>
                <Fold label="Catalogue" sub="· details, codes and packs, online check, photo, history" open={catalogueOpen} onClick={() => setCatalogueOpen((o) => !o)} testId="stock-catalogue-toggle" />
                {catalogueOpen ? (
                  <div className="space-y-4 pt-3" data-testid="stock-catalogue">
                    <Section kicker="Details">
                      {/* keyed on the item, not its revision: a reload never wipes what the office is typing */}
                      <EditForm key={item.id} item={item} unitLocked={unitLocked} onSaved={changed} />
                    </Section>
                    <Section kicker="Codes, barcodes and packs"><IdentifiersEditor item={item} onChanged={changed} /></Section>
                    <Section kicker="Online product check"><CheckSection item={item} lookupEnabled={lookupEnabled} onChanged={changed} /></Section>
                    <Section kicker="Photo">
                      <div className="flex items-start gap-3">
                        <StockThumb photoId={item.photoId} alt={item.name} size="xl" />
                        <div className="min-w-0 flex-1">
                          <PhotoCapture label="Replace photo" onPhoto={(u, _d, t) => void newPhoto(u, t)} testId="stock-drawer-photo" />
                          {photoMsg ? <p className="mt-2 text-sm text-text-muted">{photoMsg}</p> : null}
                        </div>
                      </div>
                    </Section>
                    {detail?.events?.length ? (
                      <Section kicker="Catalogue history" className="border-b-0">
                        <ul className="divide-y divide-border text-sm">
                          {detail.events.map((e) => (
                            <li key={e.id} className="py-1.5">
                              <span className="font-semibold text-text">{EVENT_LABEL[e.event] ?? e.event}</span>
                              <span className="text-text-muted"> · {e.actorName ?? "someone"} · {whenLabel(e.at)}{e.event === "updated" && e.detail && typeof e.detail === "object" && "changes" in e.detail ? ` (${Object.keys(e.detail.changes as Record<string, unknown>).join(", ")})` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      </Section>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="mt-8 border-t-2 border-border pt-3">
                <Kick>Archive</Kick>
                {archiveOpen ? (
                  <Block tone="bad" title={`Archive ${item.name}?`} className="mt-2">
                    <p>
                      It leaves the crew&rsquo;s list. {item.identifiers.length ? `Its ${item.identifiers.length} ${item.identifiers.length === 1 ? "code stops" : "codes stop"} matching photos. ` : ""}
                      Its history{item.balanceMilli ? ` and the ${balanceLabel(item)} recorded` : ""} stay on the record, read-only. There is no delete — archive is how an item goes.
                    </p>
                    <div className="flex gap-2 pt-1">
                      <Button type="button" variant="danger" size="sm" onClick={() => void archive(true)} disabled={busy} data-testid="stock-archive-confirm">Archive item</Button>
                      <Button type="button" variant="secondary" size="sm" onClick={() => setArchiveOpen(false)}>Keep it</Button>
                    </div>
                  </Block>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button type="button" variant="secondary" size="sm" onClick={() => setArchiveOpen(true)} data-testid="stock-archive">Archive item…</Button>
                    <span className="text-xs text-text-muted">Takes it off the crew&rsquo;s list; history is kept. Confirmed first.</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
