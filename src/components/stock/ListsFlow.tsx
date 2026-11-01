"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Camera, Check, ClipboardList, Loader2, Plus, Share2, Store, Warehouse } from "lucide-react";
import { cn } from "@/lib/cn";
import { deleteList, deleteListLine, fetchLists, newId, saveList, saveListLine } from "@/domains/workshop-stock/client";
import { balanceLabel, errorCopy, formatQuantity, toQuantityString, UNIT_LABEL, whenLabel } from "@/domains/workshop-stock/format";
import { listSummary, neededLabel, viewList, wholesalerQuantity, wholesalerText, type LineView } from "@/domains/workshop-stock/lists";
import { binOf } from "@/domains/workshop-stock/location";
import { UNIT_KEYS, type JobOption, type ShoppingList, type StockItem, type StockUnit, type WriteResult } from "@/domains/workshop-stock/schema";
import type { HttpResult } from "@/lib/http";
import { FlowSheet } from "./FlowSheet";
import { ItemPicker } from "./ItemPicker";
import { JobPicker } from "./JobPicker";
import { MoveConfirm, type MoveItem } from "./MoveConfirm";
import { QuantityStepper } from "./QuantityStepper";
import { StockThumb } from "./StockThumb";
import { BigButton, FIELD, FieldLabel, Kicker, LinkButton, MiniButton, Slot } from "./ui";

type Step =
  | { s: "home" }
  | { s: "new" }
  | { s: "list"; id: string }
  | { s: "add"; id: string; added: string | null }
  | { s: "add-item"; id: string; item: StockItem }
  // the line as it stood when Take was tapped: once the take saves, the line moves
  // to Got — the receipt (with its Undo) must stay put, not follow the line
  | { s: "take"; id: string; lineId: string; item: StockItem; startMilli: number | undefined };

/**
 * Shopping lists (Workshop Stock) — owner pull 2026-11-01: "on a job or in the
 * workshop, add a bunch of things; see what we need from the wholesaler and
 * what we have in the workshop; a list they can go back to and use to go
 * through and find everything."
 *
 *   Lists          yours first, then the crew's (lists are shared — anyone can
 *                  add to or tick one), then the ones finished this week
 *   One list       In the workshop (in SHELF order: one walk round), Get from
 *                  the wholesaler (copy or share it for the counter), Got
 *   Take from it   the ordinary take confirmation, starting at what the list
 *                  needs and the list's job — and it ticks the line off in the
 *                  same save. Undoing the take un-ticks it.
 *
 * A list is a plan, never a stock record (P7): "6 each recorded", not "in
 * stock". Every change waits for the server and says so if it didn't save.
 */
export function ListsFlow({
  items,
  viewerId,
  initialListId = null,
  locationPhotoEnabled = false,
  onSaved,
  onClose,
}: {
  items: StockItem[];
  viewerId: string | null;
  initialListId?: string | null;
  locationPhotoEnabled?: boolean;
  /** a take from a list saved (the host re-reads the stock list) */
  onSaved: (r: WriteResult) => void;
  onClose: () => void;
}) {
  const [lists, setLists] = useState<ShoppingList[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(initialListId ? { s: "list", id: initialListId } : { s: "home" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchLists();
    if (r.ok) { setLists(r.data.lists); setLoadError(null); }
    else setLoadError(errorCopy(r.error.status, r.error.body, "The lists didn't arrive — no signal, or the office server didn't answer."));
  }, []);
  useEffect(() => { void load(); }, [load]);

  function put(list: ShoppingList) {
    setLists((ls) => {
      const cur = ls ?? [];
      return cur.some((l) => l.id === list.id) ? cur.map((l) => (l.id === list.id ? list : l)) : [list, ...cur];
    });
  }

  /** One change, waited for: the list as the server now has it, or what went wrong. */
  async function write(key: string, fn: () => Promise<HttpResult<{ list: ShoppingList }>>): Promise<ShoppingList | null> {
    setBusy(key);
    setError(null);
    const r = await fn();
    setBusy(null);
    if (r.ok) { put(r.data.list); return r.data.list; }
    setError(errorCopy(r.error.status, r.error.body, "That didn't save — no signal, or the office server didn't answer. Try again."));
    return null;
  }

  const list = "id" in step ? lists?.find((l) => l.id === step.id) ?? null : null;

  // ── the lists ───────────────────────────────────────────────────────────────
  if (step.s === "home") {
    const open = (lists ?? []).filter((l) => !l.doneAt);
    const mine = open.filter((l) => l.ownerId === viewerId);
    const crew = open.filter((l) => l.ownerId !== viewerId);
    const done = (lists ?? []).filter((l) => l.doneAt);
    const card = (l: ShoppingList) => {
      const v = viewList(l, items);
      return (
        <li key={l.id}>
          <button type="button" onClick={() => setStep({ s: "list", id: l.id })} className="flex min-h-[64px] w-full items-center gap-3 rounded-[14px] border border-border bg-surface p-3 text-left hover:border-brand-navy" data-testid="stock-list-card">
            <ClipboardList aria-hidden="true" className="h-6 w-6 shrink-0 text-brand-navy" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold text-text">{l.name}</span>
              <span className="block truncate text-[13px] text-text-muted">{[l.jobLabel, l.ownerId === viewerId ? null : l.ownerName, whenLabel(l.updatedAt)].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="shrink-0 text-right text-[13px] font-semibold text-text">{listSummary(v)}</span>
          </button>
        </li>
      );
    };
    return (
      <FlowSheet title="Shopping lists" onClose={onClose} testId="stock-lists" footer={<BigButton variant="pri" icon={<Plus aria-hidden="true" className="h-5 w-5" />} label="Start a list" sub="for a job, or a run to the wholesaler" onClick={() => setStep({ s: "new" })} disabled={!lists} data-testid="stock-list-start" />}>
        <p className="text-[15px] text-text">What you need for a job: what&rsquo;s in the workshop, and what to get from the wholesaler.</p>
        {loadError ? <Slot tone="warn" role="alert" title="Couldn't load the lists" below={<MiniButton onClick={() => { setLoadError(null); void load(); }}>Try again</MiniButton>}>{loadError}</Slot> : null}
        {!lists && !loadError ? <p className="text-sm text-text-muted" role="status">Loading…</p> : null}
        {lists && !open.length && !done.length ? <Slot tone="neu" title="No lists yet">Start one for the next job — add what you need, then walk the workshop with it.</Slot> : null}
        {mine.length ? <Group title="Your lists">{mine.map(card)}</Group> : null}
        {crew.length ? <Group title="The crew's lists">{crew.map(card)}</Group> : null}
        {done.length ? <Group title="Finished this week">{done.map(card)}</Group> : null}
      </FlowSheet>
    );
  }

  // ── start a list ────────────────────────────────────────────────────────────
  if (step.s === "new") {
    return <NewList busy={busy === "new"} error={error} onBack={() => { setError(null); setStep({ s: "home" }); }} onClose={onClose} onStart={async (name, job) => {
      const id = newId();
      const saved = await write("new", () => saveList({ id, name, ...(job ? { jobId: job.id } : {}) }));
      if (saved) setStep({ s: "add", id: saved.id, added: null });
    }} />;
  }

  if (!list) {
    return (
      <FlowSheet title="Shopping list" onClose={onClose} onBack={() => setStep({ s: "home" })} testId="stock-list">
        {loadError ? <Slot tone="warn" role="alert" title="Couldn't load the lists" below={<MiniButton onClick={() => { setLoadError(null); void load(); }}>Try again</MiniButton>}>{loadError}</Slot> : lists ? <Slot tone="neu" title="That list isn't there any more">Someone may have deleted it.</Slot> : <p className="text-sm text-text-muted" role="status">Loading…</p>}
      </FlowSheet>
    );
  }

  // ── add to a list ───────────────────────────────────────────────────────────
  if (step.s === "add") {
    return (
      <FlowSheet title={`Add to ${list.name}`} onClose={onClose} onBack={() => { setError(null); setStep({ s: "list", id: list.id }); }} testId="stock-list-add" footer={<BigButton variant="sec" label="Done adding" sub={`back to the list · ${list.lines.length} ${list.lines.length === 1 ? "thing" : "things"} on it`} onClick={() => { setError(null); setStep({ s: "list", id: list.id }); }} data-testid="stock-list-add-done" />}>
        {step.added ? <Slot tone="ok" title={`Added ${step.added}`} role="status" testId="stock-list-added">Add the next thing, or Done adding.</Slot> : null}
        {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
        <ItemPicker
          items={items}
          placeholder="Search the workshop — name, type, size, code"
          onPick={(i) => { setError(null); setStep({ s: "add-item", id: list.id, item: i }); }}
          rowTestId="stock-list-pick"
          whenEmpty={<TextLine busy={busy === "text"} onAdd={async (text, qty, unit) => {
            const saved = await write("text", () => saveListLine({ listId: list.id, id: newId(), text, ...(qty ? { quantity: toQuantityString(qty), unit } : { unit }) }));
            if (saved) setStep({ s: "add", id: list.id, added: `${qty ? `${formatQuantity(qty, unit)} · ` : ""}${text}` });
          }} />}
        />
      </FlowSheet>
    );
  }

  if (step.s === "add-item") {
    return <AddItemQty item={step.item} listName={list.name} busy={busy === "item"} error={error} onClose={onClose} onBack={() => { setError(null); setStep({ s: "add", id: list.id, added: null }); }} onAdd={async (qty) => {
      const saved = await write("item", () => saveListLine({ listId: list.id, id: newId(), itemId: step.item.id, quantity: toQuantityString(qty) }));
      if (saved) setStep({ s: "add", id: list.id, added: `${formatQuantity(qty, step.item.baseUnit)} · ${step.item.name}` });
    }} />;
  }

  // ── take from the list ──────────────────────────────────────────────────────
  if (step.s === "take") {
    const back = () => { void load(); setStep({ s: "list", id: list.id }); };
    const job: JobOption | null = list.jobId ? { id: list.jobId, name: list.jobLabel ?? list.jobId, code: null, status: "active" } : null;
    return (
      <FlowSheet title="Take stock" direction="out" directionNote={`From ${list.name}`} onClose={onClose} onBack={back} testId="stock-list-take">
        <MoveConfirm
          item={step.item as MoveItem}
          kind="take"
          initialQtyMilli={step.startMilli}
          initialJob={job}
          listLineId={step.lineId}
          locationPhotoEnabled={locationPhotoEnabled}
          onSaved={(r) => { onSaved(r); void load(); }}
          onWrongItem={back}
          wrongItemLabel="Back to the list"
          doneLabel="Back to the list"
          doneSub="the next thing to get"
          onClose={back}
        />
      </FlowSheet>
    );
  }

  // ── one list ────────────────────────────────────────────────────────────────
  return (
    <OneList
      list={list}
      items={items}
      viewerId={viewerId}
      busy={busy}
      error={error}
      onClose={onClose}
      onBack={() => { setError(null); setStep({ s: "home" }); }}
      onAdd={() => { setError(null); setStep({ s: "add", id: list.id, added: null }); }}
      onTake={(v) => {
        if (!v.item) return;
        setError(null);
        setStep({ s: "take", id: list.id, lineId: v.line.id, item: v.item, startMilli: v.neededMilli && v.recordedMilli ? Math.min(v.neededMilli, v.recordedMilli) : undefined });
      }}
      onTick={(v, got) => void write(v.line.id, () => saveListLine({ listId: list.id, id: v.line.id, got }))}
      onQuantity={(v, milli) => void write(v.line.id, () => saveListLine({ listId: list.id, id: v.line.id, ...(v.line.itemId ? { itemId: v.line.itemId } : { unit: v.unit }), quantity: toQuantityString(milli) }))}
      onRemove={(v) => void write(v.line.id, () => deleteListLine(v.line.id))}
      onDone={(done) => void write("list", () => saveList({ id: list.id, done }))}
      onDelete={async () => {
        setBusy("list");
        const r = await deleteList(list.id);
        setBusy(null);
        if (!r.ok) { setError(errorCopy(r.error.status, r.error.body)); return; }
        setLists((ls) => (ls ?? []).filter((l) => l.id !== list.id));
        setStep({ s: "home" });
      }}
    />
  );
}

/** Change how many a line needs, or take it off — saved on Save, not on every tap. */
function LineEditor({ v, busy, onSave, onRemove, onCancel }: { v: LineView; busy: boolean; onSave: (milli: number) => void; onRemove: () => void; onCancel: () => void }) {
  const [qty, setQty] = useState(v.neededMilli ?? 1000);
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface-subtle p-2.5" data-testid="stock-line-editor">
      <QuantityStepper label="How many do you need?" valueMilli={qty} onChange={setQty} unit={v.unit} disabled={busy} testId="stock-line-qty" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LinkButton onClick={onRemove} disabled={busy} data-testid="stock-line-remove">Take it off the list</LinkButton>
        <span className="flex gap-2">
          <MiniButton onClick={onCancel} disabled={busy}>Cancel</MiniButton>
          <MiniButton variant="nav" onClick={() => onSave(qty)} disabled={busy || qty <= 0 || qty === v.neededMilli} data-testid="stock-line-save">Save · {formatQuantity(qty, v.unit)}</MiniButton>
        </span>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <Kicker>{title}</Kicker>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

function NewList({ busy, error, onStart, onBack, onClose }: { busy: boolean; error: string | null; onStart: (name: string, job: JobOption | null) => void; onBack: () => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState<JobOption | null>(null);
  const title = name.trim() || (job ? job.name : "");
  return (
    <FlowSheet title="Start a list" onClose={onClose} onBack={onBack} busy={busy} testId="stock-list-new" footer={<BigButton variant="pri" label={busy ? "Starting…" : "Start the list"} sub={title ? `then add what you need · ${title}` : "give it a name or pick the job"} disabled={!title || busy} onClick={() => onStart(title.slice(0, 80), job)} data-testid="stock-list-new-start" />}>
      <label className="block">
        <FieldLabel>What&rsquo;s it for?</FieldLabel>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Smith reno fit-off" maxLength={80} autoComplete="off" className={FIELD} data-testid="stock-list-new-name" />
      </label>
      <JobPicker value={job} onChange={setJob} label="Which job (optional)" />
      <p className="text-[13px] text-text-muted">Lists are shared with the crew — anyone can add to one or tick things off.</p>
      {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
    </FlowSheet>
  );
}

/** "Not in the workshop?" — something we don't stock, as plain text, for the wholesaler. */
function TextLine({ busy, onAdd }: { busy: boolean; onAdd: (text: string, qtyMilli: number | null, unit: StockUnit) => void }) {
  const [text, setText] = useState("");
  const [qty, setQty] = useState(1000);
  const [unit, setUnit] = useState<StockUnit>("each");
  return (
    <div className="space-y-2.5 rounded-[14px] border border-dashed border-border-strong bg-surface-subtle p-3" data-testid="stock-list-text">
      <p className="text-sm text-text"><strong>Search above</strong> for something in the workshop — or, if we don&rsquo;t stock it, write it here for the wholesaler.</p>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Clipsal 2000 series blank plate" maxLength={160} autoComplete="off" className={FIELD} aria-label="What you need from the wholesaler" data-testid="stock-list-text-input" />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Counted in">
        {UNIT_KEYS.map((u) => (
          <button key={u} type="button" onClick={() => setUnit(u)} aria-pressed={unit === u} className={cn("min-h-[36px] rounded-pill border px-3 text-[13px] font-semibold", unit === u ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text")}>
            {UNIT_LABEL[u].chip}
          </button>
        ))}
      </div>
      <QuantityStepper label="How many" valueMilli={qty} onChange={setQty} unit={unit} testId="stock-list-text-qty" />
      <BigButton variant="nav" label={busy ? "Adding…" : "Add to the list"} sub={text.trim() ? `${formatQuantity(qty, unit)} · ${text.trim()} · from the wholesaler` : "say what's needed"} disabled={!text.trim() || busy} onClick={() => { onAdd(text.trim(), qty, unit); setText(""); setQty(1000); }} data-testid="stock-list-text-add" />
    </div>
  );
}

function AddItemQty({ item, listName, busy, error, onAdd, onBack, onClose }: { item: StockItem; listName: string; busy: boolean; error: string | null; onAdd: (milli: number) => void; onBack: () => void; onClose: () => void }) {
  const [qty, setQty] = useState(1000);
  return (
    <FlowSheet title={`Add to ${listName}`} onClose={onClose} onBack={onBack} busy={busy} testId="stock-list-add-item" footer={<BigButton variant="pri" label={busy ? "Adding…" : `Add ${formatQuantity(qty, item.baseUnit)} to the list`} sub={item.name} disabled={busy || qty <= 0} onClick={() => onAdd(qty)} data-testid="stock-list-add-item-save" />}>
      <ItemCard item={item} />
      <QuantityStepper label="How many do you need?" valueMilli={qty} onChange={setQty} unit={item.baseUnit} testId="stock-list-add-item-qty" />
      <p className="text-[13px] text-text-muted">{item.balanceMilli ? `${balanceLabel(item)} recorded in the workshop.` : "None recorded in the workshop — it goes on the wholesaler part."}</p>
      {error ? <Slot tone="bad" role="alert">{error}</Slot> : null}
    </FlowSheet>
  );
}

function ItemCard({ item }: { item: StockItem }) {
  return (
    <div className="flex gap-3 rounded-[14px] border border-border bg-surface p-3">
      <StockThumb photoId={item.photoId} alt="" size="lg" />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold leading-tight text-text">{item.name}</p>
        <p className="mt-1 text-[13px] font-semibold text-text">{item.location || "No shelf set"}</p>
      </div>
    </div>
  );
}

function OneList({
  list, items, viewerId, busy, error, onClose, onBack, onAdd, onTake, onTick, onQuantity, onRemove, onDone, onDelete,
}: {
  list: ShoppingList;
  items: StockItem[];
  viewerId: string | null;
  busy: string | null;
  error: string | null;
  onClose: () => void;
  onBack: () => void;
  onAdd: () => void;
  onTake: (v: LineView) => void;
  onTick: (v: LineView, got: boolean) => void;
  onQuantity: (v: LineView, milli: number) => void;
  onRemove: (v: LineView) => void;
  onDone: (done: boolean) => void;
  onDelete: () => void;
}) {
  const view = useMemo(() => viewList(list, items), [list, items]);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const finished = Boolean(list.doneAt);
  const canDelete = list.ownerId === viewerId;

  async function share() {
    const text = wholesalerText(list, view);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title: list.name, text });
        setShared("Shared.");
        return;
      }
      await navigator.clipboard.writeText(text);
      setShared("Copied — paste it into a text or an email.");
    } catch {
      setShared("Couldn't share from this phone — read it off the screen instead.");
    }
  }

  const editor = (v: LineView) =>
    editing === v.line.id ? <LineEditor key={v.line.id} v={v} busy={busy === v.line.id} onSave={(m) => { onQuantity(v, m); setEditing(null); }} onRemove={() => onRemove(v)} onCancel={() => setEditing(null)} /> : null;

  const head = (v: LineView, extra?: ReactNode) => (
    <button type="button" onClick={() => setEditing(editing === v.line.id ? null : v.line.id)} className="min-w-0 flex-1 text-left" aria-expanded={editing === v.line.id}>
      <span className="block text-base font-semibold leading-tight text-text">{v.title}</span>
      {v.detail ? <span className="mt-0.5 block truncate text-[13px] text-text-muted">{v.detail}</span> : null}
      {extra}
    </button>
  );

  return (
    <FlowSheet
      title={list.name}
      onClose={onClose}
      onBack={onBack}
      testId="stock-list"
      footer={finished ? <BigButton variant="sec" label="Reopen this list" onClick={() => onDone(false)} disabled={busy === "list"} data-testid="stock-list-reopen" /> : <BigButton variant="pri" icon={<Plus aria-hidden="true" className="h-5 w-5" />} label="Add to the list" sub="from the workshop, or for the wholesaler" onClick={onAdd} data-testid="stock-list-add-button" />}
    >
      <div>
        <p className="text-[13px] text-text-muted">{[list.jobLabel, list.ownerId === viewerId ? "Your list" : `${list.ownerName ?? "Someone"}'s list`, finished ? `finished ${whenLabel(list.doneAt)}` : null].filter(Boolean).join(" · ")}</p>
        <p className="mt-0.5 text-[15px] font-semibold text-text" data-testid="stock-list-summary">{listSummary(view)}</p>
      </div>
      {error ? <Slot tone="bad" role="alert" title="That didn't save">{error}</Slot> : null}
      {!view.total ? <Slot tone="neu" title="Nothing on it yet">Add what you need — search the workshop, or write down what to get from the wholesaler.</Slot> : null}

      {view.workshop.length ? (
        <section className="space-y-1.5" aria-label="In the workshop" data-testid="stock-list-workshop">
          <Kicker className="flex items-center gap-1.5"><Warehouse aria-hidden="true" className="h-4 w-4" /> In the workshop · {view.workshop.length} · shelf by shelf</Kicker>
          <ul className="-mx-4 divide-y divide-border border-y border-border">
            {view.workshop.map((v) => (
              <li key={v.line.id} className="px-4 py-2.5" data-testid="stock-list-line" data-state={v.state}>
                <div className="flex items-start gap-3">
                  <StockThumb photoId={v.item?.photoId ?? null} alt="" size="md" />
                  {head(v,
                    <span className="mt-1 block text-[13px] text-text">
                      {[neededLabel(v) ? `Need ${neededLabel(v)}` : null, v.recordedMilli !== null ? `${formatQuantity(v.recordedMilli, v.unit)} recorded` : null].filter(Boolean).join(" · ")}
                      <span className="mt-0.5 flex items-center gap-1 font-semibold">
                        {v.item?.locationPhotoId ? <Camera aria-label="has a photo of where it lives" className="h-3.5 w-3.5" /> : null}
                        {v.item?.location ?? "No shelf set"}
                      </span>
                      {v.state === "short" ? <span className="mt-0.5 block font-semibold text-state-warning-subtle-text">Only {formatQuantity(v.recordedMilli ?? 0, v.unit)} recorded — get {formatQuantity(v.shortMilli, v.unit)} more from the wholesaler</span> : null}
                    </span>,
                  )}
                </div>
                {!finished ? (
                  <div className="mt-2 flex items-center justify-between gap-2 pl-[60px]">
                    <MiniButton variant="nav" onClick={() => onTake(v)} disabled={busy === v.line.id} data-testid="stock-list-take">
                      Take {v.neededMilli && v.recordedMilli ? formatQuantity(Math.min(v.neededMilli, v.recordedMilli), v.unit) : ""}{binOf(v.item?.location) ? ` · ${binOf(v.item?.location)}` : ""}
                    </MiniButton>
                    <LinkButton onClick={() => onTick(v, true)} disabled={busy === v.line.id} className="text-[13px]" data-testid="stock-list-got-other">Got it another way</LinkButton>
                  </div>
                ) : null}
                {editor(v)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.wholesaler.length ? (
        <section className="space-y-1.5" aria-label="Get from the wholesaler" data-testid="stock-list-wholesaler">
          <Kicker className="flex items-center gap-1.5"><Store aria-hidden="true" className="h-4 w-4" /> Get from the wholesaler · {view.wholesaler.length}</Kicker>
          <ul className="-mx-4 divide-y divide-border border-y border-border">
            {view.wholesaler.map((v) => (
              <li key={`w-${v.line.id}`} className="px-4 py-2.5" data-testid="stock-list-line" data-state={v.state === "short" ? "short-rest" : v.state}>
                <div className="flex items-start gap-3">
                  {v.state === "short" ? (
                    <span className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-surface-subtle text-[11px] font-bold text-text-muted">rest</span>
                  ) : (
                    <button type="button" onClick={() => onTick(v, true)} disabled={busy === v.line.id || finished} aria-label={`Got ${v.title}`} className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-2 border-brand-navy bg-surface text-brand-navy disabled:opacity-60" data-testid="stock-list-tick">
                      {busy === v.line.id ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : null}
                    </button>
                  )}
                  {head(v,
                    <span className="mt-1 block text-[13px] font-semibold text-text">
                      {wholesalerQuantity(v) ? `Get ${wholesalerQuantity(v)}` : "Get some"}
                      {v.state === "short" ? <span className="font-normal text-text-muted"> more · take the {formatQuantity(v.recordedMilli ?? 0, v.unit)} in the workshop first</span> : v.item ? <span className="font-normal text-text-muted"> · none recorded in the workshop</span> : null}
                    </span>,
                  )}
                </div>
                {v.state === "short" ? null : editor(v)}
              </li>
            ))}
          </ul>
          <MiniButton onClick={() => void share()} className="w-full" data-testid="stock-list-share"><Share2 aria-hidden="true" className="h-4 w-4" /> Copy or send the wholesaler list</MiniButton>
          {shared ? <p className="text-[13px] text-text-muted" role="status">{shared}</p> : null}
        </section>
      ) : null}

      {view.got.length ? (
        <section className="space-y-1.5" aria-label="Got" data-testid="stock-list-got">
          <Kicker className="flex items-center gap-1.5"><Check aria-hidden="true" className="h-4 w-4" /> Got · {view.got.length}</Kicker>
          <ul className="-mx-4 divide-y divide-border border-y border-border bg-surface-subtle">
            {view.got.map((v) => (
              <li key={v.line.id} className="flex items-center gap-3 px-4 py-2" data-testid="stock-list-line" data-state="got">
                <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-state-success" strokeWidth={3} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-text-muted line-through">{v.title}</span>
                  <span className="block truncate text-[13px] text-text-muted">{[v.line.movementId ? `Taken${neededLabel(v) ? ` · needed ${neededLabel(v)}` : ""}` : "Got it", v.line.gotById === viewerId ? "you" : v.line.gotByName, whenLabel(v.line.gotAt)].filter(Boolean).join(" · ")}</span>
                </span>
                {!finished ? <LinkButton className="text-[13px]" onClick={() => onTick(v, false)} disabled={busy === v.line.id} data-testid="stock-list-untick">Untick</LinkButton> : null}
              </li>
            ))}
          </ul>
          {view.got.some((v) => v.line.movementId) ? <p className="text-[13px] text-text-muted">Unticking doesn&rsquo;t undo a take — undo it from the receipt or the item.</p> : null}
        </section>
      ) : null}

      {!finished && view.total ? (
        <BigButton variant="ter" label="Finished with this list" sub={view.total - view.gotCount ? `${view.total - view.gotCount} not ticked — it keeps them` : "everything's ticked"} onClick={() => onDone(true)} disabled={busy === "list"} data-testid="stock-list-finish" />
      ) : null}

      {/* deleting sits apart from everything else, and says what it does first (P12) */}
      {canDelete ? (
        <div className="mt-6 border-t-2 border-border pt-3">
          {confirmDelete ? (
            <Slot tone="bad" title={`Delete ${list.name}?`} below={<div className="grid grid-cols-2 gap-2"><MiniButton onClick={onDelete} disabled={busy === "list"} data-testid="stock-list-delete-confirm">Delete it</MiniButton><MiniButton variant="nav" onClick={() => setConfirmDelete(false)}>Keep it</MiniButton></div>}>
              The list and its lines go for everyone. Stock already taken stays recorded.
            </Slot>
          ) : (
            <LinkButton onClick={() => setConfirmDelete(true)} className="text-text-muted" data-testid="stock-list-delete">Delete this list…</LinkButton>
          )}
        </div>
      ) : null}
    </FlowSheet>
  );
}
