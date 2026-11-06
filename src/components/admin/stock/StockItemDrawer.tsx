"use client";

import { BarcodeLabel } from "@/components/stock/BarcodeLabel";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { LocationPhoto } from "@/components/stock/LocationPhoto";
import { PhotoCapture } from "@/components/stock/PhotoCapture";
import { StockThumb } from "@/components/stock/StockThumb";
import { cn } from "@/lib/cn";
import { fetchHistory, fetchItem, newOperationKey, replaceItemPhoto, setArchived, storePhoto, undoMovement } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, identityLine, movementSummary, movementWho, signedQuantity, undoLabelFor, verificationLine, whenLabel } from "@/domains/workshop-stock/format";
import { isUncertain } from "@/domains/workshop-stock/pending";
import type { ItemDetail, StockMovement } from "@/domains/workshop-stock/schema";
import { Block, CheckSection, CountForm, EditForm, IdentifiersEditor, INPUT, LABEL } from "./StockAdminForms";
import { CODE_SHORT, CODE_TONE } from "./code-status";
import { WebPhotoFinder } from "./WebPhotoFinder";

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

type DrawerTab = "stock" | "details" | "label";

/** The drawer's three views — what's recorded, the catalogue, the label — as tabs instead of one long scroll. */
function Tabs({ value, onChange, tabs }: { value: DrawerTab; onChange: (t: DrawerTab) => void; tabs: Array<{ value: DrawerTab; label: string; testId: string }> }) {
  return (
    <div role="tablist" aria-label="Item" className="-mx-5 -mt-4 flex gap-1 border-b border-border px-5">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cn("-mb-px border-b-2 px-2.5 pb-2.5 pt-3 text-[13px] font-medium", t.value === value ? "border-brand-navy text-text" : "border-transparent text-text-muted hover:text-text")}
          data-testid={t.testId}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: "Added to the catalogue", updated: "Details edited", archived: "Archived", restored: "Restored",
  identifier_added: "Code added", identifier_removed: "Code removed", photo_changed: "Photo changed", verification_recorded: "Online check recorded",
};

/**
 * The office view of one workshop item, in three tabs (2026-11-03: one long
 * scroll read as clunky). Stock, first: what's recorded, Correct the count,
 * then the movement history with its audited Undo (a reason, written into the
 * history). Details: the catalogue (details, codes and packs, the online
 * check, the photos, its own history), with archive last and apart (P12: the
 * destructive action never sits beside routine ones). Label: the NIIMBOT
 * barcode label. An archived item is read-only until it is restored.
 */
export function StockItemDrawer({ itemId, lookupEnabled, locationPhotoEnabled = false, typesEnabled = false, labelOpenAtStart = false, onClose, onChanged }: { itemId: string; lookupEnabled: boolean; locationPhotoEnabled?: boolean; typesEnabled?: boolean; labelOpenAtStart?: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [older, setOlder] = useState<StockMovement[]>([]);
  const [next, setNext] = useState<{ before: string; beforeId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoFor, setUndoFor] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<DrawerTab>(labelOpenAtStart ? "label" : "stock");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [locationMsg, setLocationMsg] = useState<string | null>(null);
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

  // The photo of where it lives: replace with a new one, or remove (null).
  async function setLocationPhoto(dataUrl: string | null, thumbDataUrl: string | null) {
    setLocationMsg(dataUrl ? "Saving photo…" : "Removing…");
    let id: string | null = null;
    if (dataUrl) {
      const s = await storePhoto(dataUrl, thumbDataUrl);
      if (!s.ok) { setLocationMsg(errorCopy(s.error.status, s.error.body)); return; }
      id = s.data.photoId;
    }
    const r = await replaceItemPhoto(itemId, id, "location");
    setLocationMsg(r.ok ? (id ? "Photo of where it lives changed." : "Photo of where it lives removed.") : (r.error.body as { error?: string } | null)?.error === "location_photo_unavailable" ? "Photos of where items live aren't set up yet." : errorCopy(r.error.status, r.error.body));
    if (r.ok) changed();
  }

  const item = detail?.item;
  const movements = [...(detail?.movements ?? []), ...older];
  const unitLocked = movements.some((m) => m.quantityMilli !== 0 || (m.countedMilli ?? 0) !== 0);
  const unit = item?.baseUnit ?? "each";

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
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "stock", label: "Stock", testId: "stock-drawer-tab-stock" },
                  { value: "details", label: "Details", testId: "stock-catalogue-toggle" },
                  { value: "label", label: "Label", testId: "stock-label-toggle" },
                ]}
              />

              {tab === "stock" ? (
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
                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div className="min-w-0">
                        <dt className={LABEL}>Shelf</dt>
                        <dd className="truncate text-text" title={item.location ?? undefined}>{item.location || "Not set"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className={LABEL}>Last counted</dt>
                        <dd className="text-text">{item.lastCountedAt ? `${whenLabel(item.lastCountedAt)}${item.lastCountedByName ? ` · ${item.lastCountedByName}` : ""}` : "Never"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className={LABEL}>Product code</dt>
                        <dd title={verificationLine(item)}><Pill tone={CODE_TONE[item.verificationStatus]} dot className="whitespace-nowrap font-medium normal-case tracking-normal">{CODE_SHORT[item.verificationStatus]}</Pill></dd>
                      </div>
                    </dl>
                    {item.locationPhotoId ? <LocationPhoto photoId={item.locationPhotoId} location={item.location} /> : null}
                    {/* no photo yet: one tap to the product photo online, without leaving the Stock tab */}
                    {!item.photoId ? <WebPhotoFinder item={item} lookupEnabled={lookupEnabled} onUsed={changed} compact /> : null}
                  </Section>

                  <Section kicker="Correct the count"><CountForm key={item.id} item={item} onSaved={changed} /></Section>

                  <Section kicker="Movement history" className="border-b-0">
                    {history}
                  </Section>
                </>
              ) : null}

              {tab === "details" ? (
                <div className="space-y-4" data-testid="stock-catalogue">
                  <Section kicker="Details">
                    {/* keyed on the item, not its revision: a reload never wipes what the office is typing */}
                    <EditForm key={item.id} item={item} unitLocked={unitLocked} typesEnabled={typesEnabled} onSaved={changed} />
                  </Section>
                  <Section kicker="Codes, barcodes and packs"><IdentifiersEditor item={item} onChanged={changed} /></Section>
                  <Section kicker="Online product check"><CheckSection item={item} lookupEnabled={lookupEnabled} onChanged={changed} /></Section>
                  <Section kicker="Photo">
                    <div className="flex items-start gap-3">
                      <StockThumb photoId={item.photoId} alt={item.name} size="xl" />
                      <div className="min-w-0 flex-1">
                        <PhotoCapture label="Replace photo" onPhoto={(u, _d, t) => void newPhoto(u, t)} testId="stock-drawer-photo" />
                        {photoMsg ? <p className="mt-2 text-sm text-text-muted">{photoMsg}</p> : null}
                        <div className="mt-3 border-t border-border pt-3">
                          <WebPhotoFinder item={item} lookupEnabled={lookupEnabled} onUsed={changed} />
                        </div>
                      </div>
                    </div>
                  </Section>
                  {locationPhotoEnabled ? (
                    <Section kicker="Photo of where it lives">
                      <p className="text-xs text-text-muted">For stock that isn&rsquo;t in an obvious place — shown to whoever comes to take it, beside the shelf.</p>
                      {item.locationPhotoId ? <LocationPhoto photoId={item.locationPhotoId} location={item.location} /> : <p className="text-sm text-text-muted">None yet.</p>}
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <PhotoCapture label={item.locationPhotoId ? "Replace photo" : "Add photo"} onPhoto={(u, _d, t) => void setLocationPhoto(u, t)} testId="stock-drawer-location-photo" />
                        </div>
                        {item.locationPhotoId ? (
                          <Button type="button" variant="secondary" size="sm" onClick={() => void setLocationPhoto(null, null)} data-testid="stock-drawer-location-photo-remove">Remove</Button>
                        ) : null}
                      </div>
                      {locationMsg ? <p className="text-sm text-text-muted" role="status">{locationMsg}</p> : null}
                    </Section>
                  ) : null}
                  {detail?.events?.length ? (
                    <Section kicker="Catalogue history" className="border-b-0">
                      <ul className="divide-y divide-border text-sm">
                        {detail.events.map((e) => (
                          <li key={e.id} className="py-1.5">
                            <span className="font-semibold text-text">{e.event === "photo_changed" && (e.detail as { slot?: string } | null)?.slot === "location" ? ((e.detail as { to?: string | null }).to ? "Photo of where it lives changed" : "Photo of where it lives removed") : e.event === "photo_changed" && (e.detail as { source?: string } | null)?.source === "web" ? `Photo changed — product photo from ${(e.detail as { domain?: string | null }).domain ?? "the web"}` : EVENT_LABEL[e.event] ?? e.event}</span>
                            <span className="text-text-muted"> · {e.actorName ?? "someone"} · {whenLabel(e.at)}{e.event === "updated" && e.detail && typeof e.detail === "object" && "changes" in e.detail ? ` (${Object.keys(e.detail.changes as Record<string, unknown>).join(", ")})` : ""}</span>
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}

                  {/* archive: last, and apart from everything routine (P12) */}
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
                </div>
              ) : null}

              {tab === "label" ? (
                <div className="space-y-2">
                  <p className="text-sm text-text-muted">A NIIMBOT barcode label, for items with no packaging to scan.</p>
                  <BarcodeLabel item={item} onItemChanged={changed} directPrint />
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
