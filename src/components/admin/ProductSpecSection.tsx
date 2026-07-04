"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { getJobSpec, saveJobSpec } from "@/domains/job-spec/client";
import { PRODUCT_SPEC_LIMITS, type ProductSpecSystem } from "@/domains/job-spec/schema";

/**
 * Product spec editor — the builder's "Spec & circuits" step (Job Builder
 * redesign · Wave 3, dark behind job_builder_redesign). The product half of
 * the prototype's §5.7: per-system product lines (qty · product · who
 * supplies) + a per-system edge-case note. The Power/circuits half is the
 * SHIPPED circuit schedule — linked out, not rebuilt.
 *
 * Explicit save (the builder's convention — no confusing autosave): edits are
 * local until "Save spec"; the server (api/job-spec.js) validates, preserves
 * ids, and is the only writer of job.productSpec.
 *
 * Honesty (P7): qty is null until someone counts — rendered as an empty field,
 * never a fake 0. Empty register shows the honest empty state.
 */

type Load =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready" };

interface Props {
  jobId: string;
}

let uid = 0;
/** Local-only placeholder id — the server mints real ps_/pl_ ids on save. */
function localId(prefix: string): string {
  uid += 1;
  return `${prefix}local_${uid}`;
}

export function ProductSpecSection({ jobId }: Props) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [systems, setSystems] = useState<ProductSpecSystem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await getJobSpec(jobId);
    if (!res.ok) {
      setLoad({ phase: "error", message: res.error.message });
      return;
    }
    setSystems(res.data.systems);
    setDirty(false);
    setLoad({ phase: "ready" });
  }, [jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function mutate(fn: (prev: ProductSpecSystem[]) => ProductSpecSystem[]) {
    setSystems(fn);
    setDirty(true);
    setSavedAt(null);
  }

  function addSystem() {
    mutate((prev) => [
      ...prev,
      { id: localId("ps_"), name: "", edgeNote: "", lines: [] },
    ]);
  }

  function updateSystem(si: number, patch: Partial<ProductSpecSystem>) {
    mutate((prev) => prev.map((s, i) => (i === si ? { ...s, ...patch } : s)));
  }

  function removeSystem(si: number) {
    mutate((prev) => prev.filter((_, i) => i !== si));
  }

  function addLine(si: number) {
    mutate((prev) =>
      prev.map((s, i) =>
        i === si
          ? { ...s, lines: [...s.lines, { id: localId("pl_"), qty: null, product: "", supplier: "" }] }
          : s,
      ),
    );
  }

  function updateLine(si: number, li: number, patch: Partial<ProductSpecSystem["lines"][number]>) {
    mutate((prev) =>
      prev.map((s, i) =>
        i === si
          ? { ...s, lines: s.lines.map((l, j) => (j === li ? { ...l, ...patch } : l)) }
          : s,
      ),
    );
  }

  function removeLine(si: number, li: number) {
    mutate((prev) =>
      prev.map((s, i) => (i === si ? { ...s, lines: s.lines.filter((_, j) => j !== li) } : s)),
    );
  }

  // Client-side gate matching the server: names + products must be non-empty.
  const invalid =
    systems.some((s) => !s.name.trim()) ||
    systems.some((s) => s.lines.some((l) => !l.product.trim()));

  async function save() {
    if (invalid) return;
    setSaving(true);
    setSaveError(null);
    // Local placeholder ids are stripped — the server mints real ones.
    const payload = systems.map((s) => ({
      ...s,
      id: s.id.startsWith("ps_local_") ? "" : s.id,
      lines: s.lines.map((l) => ({ ...l, id: l.id.startsWith("pl_local_") ? "" : l.id })),
    })) as ProductSpecSystem[];
    const res = await saveJobSpec(jobId, payload);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error.message);
      return;
    }
    setSystems(res.data.systems);
    setDirty(false);
    setSavedAt("Saved");
  }

  const inputClass =
    "w-full rounded-card border border-border bg-surface px-2.5 py-1.5 text-sm text-text outline-none focus:border-border-strong";

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Product spec</CardTitle>
            <CardDescription className="mt-1">
              The product for every item and who supplies it — brand, model, cut-out. Blank
              supplier means we supply. Feeds the crew&rsquo;s certainty on site: if it&rsquo;s not
              on the spec, it&rsquo;s a question, not a guess.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {savedAt && !dirty ? (
              <span className="text-xs text-text-muted" role="status">
                All changes saved
              </span>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={addSystem}
              disabled={saving || systems.length >= PRODUCT_SPEC_LIMITS.systems}
              data-testid="spec-add-system"
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> System
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || saving || invalid}
              data-testid="spec-save"
            >
              {saving ? "Saving…" : "Save spec"}
            </Button>
          </div>
        </div>

        {saveError ? (
          <p role="alert" className="mt-3 rounded-card border border-state-danger bg-rose-50 px-3 py-2 text-sm text-state-danger">
            {saveError}
          </p>
        ) : null}
        {invalid && dirty ? (
          <p className="mt-3 text-xs text-state-danger">
            Every system needs a name and every line needs a product before saving.
          </p>
        ) : null}
      </Card>

      {load.phase === "loading" ? (
        <Card>
          <p className="text-sm text-text-muted" role="status">
            Loading product spec…
          </p>
        </Card>
      ) : null}

      {load.phase === "error" ? (
        <Card className="border-state-danger" role="alert">
          <CardTitle>Couldn&rsquo;t load the product spec</CardTitle>
          <CardDescription className="mt-1">{load.message}</CardDescription>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        </Card>
      ) : null}

      {load.phase === "ready" && systems.length === 0 ? (
        <Card data-testid="spec-empty">
          <p className="rounded-card border border-dashed border-border bg-surface-subtle px-3 py-6 text-center text-sm text-text-muted">
            No product spec yet. Add a system (Power / GPOs, Lighting, Data…) and list what gets
            installed — the crew reads this as the source of truth for what goes where.
          </p>
        </Card>
      ) : null}

      {load.phase === "ready"
        ? systems.map((s, si) => (
            <Card key={s.id} data-testid="spec-system">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="min-w-0 grow">
                  <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
                    System
                  </span>
                  <input
                    className={inputClass}
                    value={s.name}
                    onChange={(e) => updateSystem(si, { name: e.target.value })}
                    placeholder="e.g. Power / GPOs"
                    data-testid="spec-system-name"
                  />
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSystem(si)}
                  disabled={saving}
                  aria-label={`Remove system ${s.name || si + 1}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>

              <label className="mt-3 block">
                <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
                  Edge-case note <span className="normal-case">(the rule the crew must not guess)</span>
                </span>
                <input
                  className={inputClass}
                  value={s.edgeNote}
                  onChange={(e) => updateSystem(si, { edgeNote: e.target.value })}
                  placeholder="e.g. Anything not on E-201 rev C is a variation — flag it before you rough it in."
                />
              </label>

              {s.lines.length > 0 ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
                        <th className="w-20 pb-1 pr-2 font-normal">Qty</th>
                        <th className="pb-1 pr-2 font-normal">Product (brand · model · cut-out)</th>
                        <th className="w-48 pb-1 pr-2 font-normal">Who supplies (blank = us)</th>
                        <th className="w-10 pb-1" aria-label="Remove" />
                      </tr>
                    </thead>
                    <tbody>
                      {s.lines.map((l, li) => (
                        <tr key={l.id}>
                          <td className="py-1 pr-2 align-top">
                            <input
                              className={inputClass}
                              inputMode="numeric"
                              value={l.qty === null ? "" : String(l.qty)}
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                if (raw === "") return updateLine(si, li, { qty: null });
                                const n = Number(raw);
                                if (Number.isFinite(n) && n >= 0) updateLine(si, li, { qty: Math.round(n) });
                              }}
                              placeholder="—"
                              aria-label="Quantity"
                            />
                          </td>
                          <td className="py-1 pr-2 align-top">
                            <input
                              className={inputClass}
                              value={l.product}
                              onChange={(e) => updateLine(si, li, { product: e.target.value })}
                              placeholder="e.g. Clipsal Iconic 3025 double GPO, white"
                              data-testid="spec-line-product"
                            />
                          </td>
                          <td className="py-1 pr-2 align-top">
                            <input
                              className={inputClass}
                              value={l.supplier}
                              onChange={(e) => updateLine(si, li, { supplier: e.target.value })}
                              placeholder=""
                              aria-label="Who supplies"
                            />
                          </td>
                          <td className="py-1 align-top">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeLine(si, li)}
                              disabled={saving}
                              aria-label="Remove line"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-3 text-xs text-text-muted">No lines yet.</p>
              )}

              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => addLine(si)}
                  disabled={saving || s.lines.length >= PRODUCT_SPEC_LIMITS.linesPerSystem}
                  data-testid="spec-add-line"
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Line
                </Button>
              </div>
            </Card>
          ))
        : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Power — circuits &amp; board schedule</CardTitle>
            <CardDescription className="mt-1">
              Assign areas to circuits and build the AS/NZS-3000 board schedule on its own surface —
              the builder links out rather than duplicating it.
            </CardDescription>
          </div>
          <Link
            href={`/v2/jobs/${jobId}/circuit-schedule` as Route}
            className="inline-flex items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse"
          >
            Open circuit schedule <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
