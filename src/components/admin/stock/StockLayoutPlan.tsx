"use client";

import { useMemo, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { newOperationKey } from "@/domains/workshop-stock/client";
import { recommendLayout, type LayoutPlan } from "@/domains/workshop-stock/location-layout";
import { binKey, locationText, rackLabel, rulesInBin, type LocationMatrix, type MatrixRule } from "@/domains/workshop-stock/location-matrix";
import type { StockItem } from "@/domains/workshop-stock/schema";

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function PlanSummary({ plan }: { plan: LayoutPlan<StockItem> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1" data-testid="stock-layout-summary">
      <li className="console-label">{count(plan.rules.length, "new rule")}</li>
      <li className="console-label">{count(plan.moves.length, "item")} to move</li>
      <li className="console-label">{plan.stays} already in place</li>
      <li className="console-label">{count(plan.spare, "bin")} left over</li>
    </ul>
  );
}

function PlanRack({ matrix, plan, rack }: { matrix: LocationMatrix; plan: LayoutPlan<StockItem>; rack: LocationMatrix["racks"][number] }) {
  return (
    <section aria-label={`${rackLabel(rack.name)}, recommended`} data-testid="stock-layout-rack">
      <h4 className="font-display text-sm font-semibold text-text">{rackLabel(rack.name)}</h4>
      <div className="mt-1 overflow-x-auto">
        <table className="border-separate border-spacing-1 text-left">
          <thead>
            <tr>
              <th scope="col" className="sr-only">Shelf</th>
              {Array.from({ length: rack.bins }, (_, b) => <th key={b} scope="col" className="console-label px-1 text-center">Bin {b + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rack.shelves }, (_, s) => (
              <tr key={s}>
                <th scope="row" className="console-label whitespace-nowrap pr-2">Shelf {s + 1}</th>
                {Array.from({ length: rack.bins }, (_, b) => {
                  const shelf = s + 1;
                  const bin = b + 1;
                  const planned = plan.bins.get(binKey(rack.id, shelf, bin));
                  const keptHere = rulesInBin({ racks: matrix.racks, rules: plan.kept }, rack.id, shelf, bin);
                  const where = locationText(rack, shelf, bin);
                  if (planned) {
                    const room = !planned.labels.length;
                    return (
                      <td key={b} className="p-0 align-top">
                        <div data-zone={planned.family.key} className="console-zone h-14 w-28 overflow-hidden rounded-[4px] border p-1 text-xs leading-tight text-text" data-testid="stock-layout-bin" aria-label={`${where}: ${room ? `room for more ${planned.family.label}` : planned.labels.join(", ")}`} role="img">
                          {room ? <span className="text-text-muted">Room for more</span> : <span className="line-clamp-2 font-medium">{planned.labels.join(", ")}</span>}
                          {planned.stock ? <span className="block font-mono text-text-muted">{count(planned.stock, "item")}</span> : null}
                        </div>
                      </td>
                    );
                  }
                  return (
                    <td key={b} className="p-0 align-top">
                      <div className={cn("h-14 w-28 overflow-hidden rounded-[4px] border p-1 text-xs leading-tight text-text-muted", keptHere.length ? "border-dashed border-border-strong bg-surface" : "border-border bg-surface-subtle")} role="img" aria-label={`${where}: ${keptHere.length ? `your rule, ${keptHere.map((r) => r.words).join(", ")}` : "not used"}`}>
                        {keptHere.length ? <span className="line-clamp-2">{keptHere.map((r) => r.words).join(", ")}</span> : <span aria-hidden="true" className="font-mono">·</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The recommended layout on /stock/locations: related stock side by side (GPOs by
 * switches, patch leads by data jacks), shown on the racks before anything is saved.
 * Using it saves ordinary rules, so new stock goes there; recorded stock then shows
 * under "Needs a place" and moves only when someone taps. Undo puts the rules back.
 */
export function StockLayoutPlan({ matrix, items, saving, onSaveRules }: { matrix: LocationMatrix; items: StockItem[] | null; saving: boolean; onSaveRules: (rules: MatrixRule[]) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [keepRules, setKeepRules] = useState(true);
  const [saved, setSaved] = useState<{ previous: MatrixRule[]; rules: number; moves: number } | null>(null);

  const plan = useMemo(() => (open && items ? recommendLayout(items, matrix, { keepRules }) : null), [open, items, matrix, keepRules]);

  async function applyLayout() {
    if (!plan) return;
    const previous = matrix.rules;
    const added = plan.rules.map((r) => ({ ...r, id: newOperationKey() }));
    if (await onSaveRules([...plan.kept, ...added])) {
      setSaved({ previous, rules: added.length, moves: plan.moves.length });
      setOpen(false);
      setKeepRules(true);
    }
  }

  async function undo() {
    if (saved && (await onSaveRules(saved.previous))) setSaved(null);
  }

  return (
    <section className="rounded-[4px] border border-border bg-surface p-3" data-testid="stock-layout">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[14rem] flex-1">
          <h2 className="console-label">Recommended layout</h2>
          {!open ? <p className="mt-1 text-sm text-text-muted">Keeps related stock together across your racks: GPOs beside switches, patch leads beside data jacks. Nothing changes until you use it.</p> : null}
        </div>
        {open ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} data-testid="stock-layout-close">Close</Button>
        ) : (
          <Button type="button" size="sm" disabled={!items} onClick={() => { setSaved(null); setOpen(true); }} data-testid="stock-layout-open"><LayoutGrid aria-hidden="true" className="h-4 w-4" /> Recommend a layout</Button>
        )}
      </div>

      {saved ? (
        <div className="console-rise mt-2 flex flex-wrap items-center gap-2 rounded-[4px] border border-border-strong bg-surface-raised px-3 py-2" role="status" data-testid="stock-layout-saved">
          <p className="min-w-[14rem] flex-1 text-sm text-text">
            Layout saved, with {count(saved.rules, "new rule")}. New stock now goes to these bins.{saved.moves ? ` ${count(saved.moves, "item")} to move ${saved.moves === 1 ? "is" : "are"} listed under Needs a place.` : ""}
          </p>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void undo()} data-testid="stock-layout-undo">Undo</Button>
        </div>
      ) : null}

      {open && plan ? (
        <div className="console-rise mt-3 space-y-3">
          <PlanSummary plan={plan} />

          {matrix.rules.length ? (
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={keepRules} onChange={(e) => setKeepRules(e.target.checked)} data-testid="stock-layout-keep" />
              Keep the {count(matrix.rules.length, "rule")} already set
              {!keepRules ? <span className="text-state-warning">Using this replaces them.</span> : null}
            </label>
          ) : null}

          {plan.shared ? <p className="text-sm text-state-warning" data-testid="stock-layout-shared">There are more groups than free bins, so neighbours share a bin. Add a rack or shelves to spread them out.</p> : null}

          {plan.families.length ? (
            <ol className="grid gap-x-4 gap-y-2 sm:grid-cols-2" data-testid="stock-layout-families">
              {plan.families.map(({ family, bins, stock, from, to }) => (
                <li key={family.key} data-zone={family.key} className="flex gap-2" data-testid="stock-layout-family">
                  <span aria-hidden="true" className="console-swatch mt-1 h-3 w-3 shrink-0 rounded-[2px]" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{family.label} <span className="font-normal text-text-muted">· {count(bins, "bin")}{stock ? ` · ${count(stock, "item")}` : ""}</span></p>
                    <p className="font-mono text-xs uppercase text-text-muted">{from === to ? from : `${from} to ${to}`}</p>
                    <p className="text-xs text-text-muted">{family.why}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-text-muted" data-testid="stock-layout-nothing">Every group with stock already has a bin, so there&rsquo;s nothing new to add.</p>}

          {plan.rules.length ? <div className="space-y-3">{matrix.racks.map((rack) => <PlanRack key={rack.id} matrix={matrix} plan={plan} rack={rack} />)}</div> : null}

          {plan.moves.length ? (
            <details className="text-sm text-text" data-testid="stock-layout-moves">
              <summary className="cursor-pointer text-text-muted">What would move ({plan.moves.length})</summary>
              <ul className="mt-1 max-h-60 divide-y divide-border overflow-y-auto">
                {plan.moves.map(({ item, from, to }) => (
                  <li key={item.id} className="flex flex-wrap gap-x-3 py-1.5">
                    <span className="min-w-[12rem] flex-1">{item.name}</span>
                    <span className="text-xs text-text-muted">{from ?? "No location"} → <span className="font-mono uppercase text-accent-yellow">{to}</span></span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {plan.unsorted.length ? (
            <details className="text-sm text-text" data-testid="stock-layout-unsorted">
              <summary className="cursor-pointer text-text-muted">Not in any group ({plan.unsorted.length})</summary>
              <p className="mt-1 text-xs text-text-muted">Their names don&rsquo;t say what they are, so no rule would catch them. They stay where they are.</p>
              <ul className="mt-1 max-h-40 overflow-y-auto text-sm">
                {plan.unsorted.map((item) => <li key={item.id} className="py-0.5">{item.name}{item.location ? <span className="text-text-muted"> · {item.location}</span> : null}</li>)}
              </ul>
            </details>
          ) : null}

          {plan.rules.length ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button type="button" size="sm" disabled={saving} onClick={() => void applyLayout()} data-testid="stock-layout-use">Use this layout</Button>
              <p className="min-w-[14rem] flex-1 text-xs text-text-muted">Saves the rules so new stock goes to these bins. Stock already recorded stays put until you move it.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
