"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { saveCustomType } from "@/domains/workshop-stock/client";
import { errorCopy, UNIT_LABEL } from "@/domains/workshop-stock/format";
import { UNIT_KEYS, type CustomType, type StockItem, type StockUnit } from "@/domains/workshop-stock/schema";
import { isCustomType, STOCK_TYPES, typeNameTaken, valueKey } from "@/domains/workshop-stock/types";
import { Block, INPUT } from "./StockAdminForms";

const MAX_FIELDS = 8;

const SAVE_ERRORS: Record<string, string> = {
  type_name_taken: "Another category already has that name.",
  type_name_invalid: "Give the category a name with at least one letter or number.",
  field_name_invalid: "A field needs a name with a letter or number (Brand is already there).",
  field_name_repeated: "Two fields have the same name.",
  too_many_fields: `A category can have up to ${MAX_FIELDS} fields.`,
  types_unavailable: "Categories aren't switched on in the database yet.",
  office_only: "Only the office can add categories.",
};

/**
 * /stock → Categories: the built-in categories the app comes with, and the
 * office's own (owner pull 2026-11-03: "create new categories when the need
 * comes up"). An office category has a name, what it's counted in, and its own
 * fields — each a filter when the crew browse it on the phone, with the shop's
 * own values offered as quick picks. Fields can be renamed and added later,
 * never removed (values already saved on items stay readable).
 */
export function StockCategories({ customTypes, items, onSaved, onClose }: { customTypes: CustomType[]; items: StockItem[]; onSaved: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState<CustomType | "new" | null>(null);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (i.category && !i.archivedAt) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [items]);
  const builtIns = STOCK_TYPES.filter((t) => !isCustomType(t.key));

  if (editing) {
    return (
      <Drawer open onClose={onClose} title={editing === "new" ? "New category" : `Change “${editing.label}”`} subtitle="workshop stock · categories">
        <CategoryForm
          current={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); onSaved(); }}
        />
      </Drawer>
    );
  }

  return (
    <Drawer open onClose={onClose} title="Categories" subtitle="workshop stock · what the crew browse by">
      <div className="space-y-4" data-testid="stock-categories">
        <p className="text-sm text-text-muted">
          The crew browse stock by category on the phone, and each field is a filter. Add one when something doesn&rsquo;t fit the list. Values are typed in once, then offered as quick picks.
        </p>
        <Button type="button" size="sm" onClick={() => setEditing("new")} data-testid="stock-category-new">
          <Plus aria-hidden="true" className="h-4 w-4" /> New category
        </Button>

        <section className="space-y-2" aria-label="Your categories">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Yours</h3>
          {customTypes.length ? (
            <ul className="divide-y divide-border rounded-card border border-border" data-testid="stock-category-list">
              {customTypes.map((t) => (
                <li key={t.key} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-text">{t.label}</p>
                    <p className="text-[13px] text-text-muted">
                      Brand{t.fields.length ? `, ${t.fields.map((f) => f.label).join(", ")}` : ""} · counted in {UNIT_LABEL[t.unit].chip.toLowerCase()} · {used.get(t.key) ?? 0} {(used.get(t.key) ?? 0) === 1 ? "item" : "items"}
                    </p>
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(t)} data-testid="stock-category-edit">Change</Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-sm text-text-muted">None yet. The built-in ones are below.</p>
          )}
        </section>

        <section className="space-y-2" aria-label="Built-in categories">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Built in</h3>
          <ul className="divide-y divide-border rounded-card border border-border">
            {builtIns.map((t) => (
              <li key={t.key} className="px-3 py-2">
                <p className="text-sm font-semibold text-text">{t.label}</p>
                <p className="text-[12.5px] text-text-muted">{t.fields.map((f) => f.label).join(", ")}{used.get(t.key) ? ` · ${used.get(t.key)} ${used.get(t.key) === 1 ? "item" : "items"}` : ""}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

type FieldRow = { key?: string; label: string };

function CategoryForm({ current, onCancel, onSaved }: { current: CustomType | null; onCancel: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(current?.label ?? "");
  const [unit, setUnit] = useState<StockUnit>(current?.unit ?? "each");
  const [fields, setFields] = useState<FieldRow[]>(current ? current.fields.map((f) => ({ ...f })) : [{ label: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const named = fields.filter((f) => f.label.trim());
  const clash = label.trim() ? typeNameTaken(label, current?.key) : null;
  const repeated = named.some((f, i) => named.findIndex((g) => valueKey(g.label) === valueKey(f.label)) !== i) || named.some((f) => valueKey(f.label) === "brand");
  const canSave = Boolean(label.trim()) && !clash && !repeated && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const r = await saveCustomType({ key: current?.key, label: label.trim(), unit, fields: named.map((f) => ({ key: f.key, label: f.label.trim() })) });
    setBusy(false);
    if (!r.ok) {
      const code = (r.error.body as { error?: string } | null)?.error ?? "";
      setError(SAVE_ERRORS[code] ?? errorCopy(r.error.status, r.error.body, "The category wasn't saved."));
      return;
    }
    onSaved();
  }

  return (
    <div className="space-y-4" data-testid="stock-category-form">
      <label className="block text-sm font-medium text-text">
        Name
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g. Solar inverters" className={cn(INPUT, "mt-1")} data-testid="stock-category-name" autoFocus />
      </label>
      {clash ? <p className="text-sm text-state-danger" role="alert">“{clash.label}” already exists — use that one, or pick another name.</p> : null}

      <label className="block text-sm font-medium text-text">
        Counted in
        <select value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)} className={cn(INPUT, "mt-1")} data-testid="stock-category-unit">
          {UNIT_KEYS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u].chip}</option>)}
        </select>
        <span className="mt-1 block text-[12.5px] font-normal text-text-muted">What new items of this kind start with — each item can still be changed.</span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text">Fields</legend>
        <p className="text-[12.5px] text-text-muted">What tells one of these apart from another — e.g. Power, Phase, Size. Brand is always there. Each field is a filter on the phone.</p>
        <div className="rounded-[4px] border border-dashed border-border bg-surface-subtle px-2.5 py-2 text-sm text-text-muted">Brand</div>
        {fields.map((f, i) => (
          <div key={f.key ?? `new-${i}`} className="flex items-center gap-2">
            <input
              value={f.label}
              onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              maxLength={30}
              placeholder={i === 0 ? "e.g. Power" : "Field name"}
              aria-label={`Field ${i + 1}`}
              className={INPUT}
              data-testid="stock-category-field"
            />
            {f.key ? null : (
              <button type="button" aria-label={`Remove field ${i + 1}`} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-border text-text-muted hover:border-border-strong">
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {repeated ? <p className="text-sm text-state-danger" role="alert">Each field needs its own name (Brand is already there).</p> : null}
        {fields.length < MAX_FIELDS ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setFields((fs) => [...fs, { label: "" }])} data-testid="stock-category-add-field">
            <Plus aria-hidden="true" className="h-4 w-4" /> Add a field
          </Button>
        ) : <p className="text-[12.5px] text-text-muted">Up to {MAX_FIELDS} fields.</p>}
        {current ? <p className="text-[12.5px] text-text-muted">Saved fields can be renamed but not removed, so what&rsquo;s already filled in on items stays.</p> : null}
      </fieldset>

      {error ? <Block tone="bad" title="Not saved" role="alert"><p>{error}</p></Block> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save()} disabled={!canSave} data-testid="stock-category-save">{busy ? "Saving…" : current ? "Save changes" : "Add category"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Back</Button>
      </div>
    </div>
  );
}
