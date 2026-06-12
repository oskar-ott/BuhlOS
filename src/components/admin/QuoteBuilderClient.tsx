"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { saveQuote } from "@/domains/quoting/client";
import { quoteStatusLabel, quoteStatusTone } from "@/domains/quoting/format";
import {
  computeQuoteTotals,
  formatMoney,
  lineTotal,
  sectionSubtotal,
} from "@/domains/quoting/totals";
import {
  QUOTE_LIMITS,
  QuoteConflictResponseSchema,
  type Quote,
  type QuoteLineKind,
  type QuoteSaveInput,
} from "@/domains/quoting/schema";

/**
 * /v2/quotes/[quoteId] builder body (#183) — sections of line items with
 * LIVE totals (src/domains/quoting/totals.ts; the server recomputes the
 * same numbers on save, golden-fixture-pinned in both test suites).
 *
 * Save model: ONE explicit full-document PUT — no per-keystroke autosave
 * (the legacy per-section PATCH + touchQuote write amplification is exactly
 * what the #172 ruling retired). The save chip tells the estimator where
 * they stand (saved / unsaved / saving / failed); a 409 (edited in another
 * tab) surfaces the stale banner offering to load the server's copy.
 *
 * FOUNDATION SCOPE: plain lines only (kind material|labour|other). Markup,
 * provisional sums, contingency and margin are the calculator children
 * (#193/#195/#214/#223); versions/approval/PDF/acceptance/conversion are
 * dark here on purpose — no stubs.
 */

interface LineForm {
  /** Stable client key (server id once persisted; random for new lines). */
  key: string;
  id?: string;
  kind: QuoteLineKind;
  description: string;
  qty: string;
  unit: string;
  rate: string;
}

interface SectionForm {
  key: string;
  id?: string;
  title: string;
  lines: LineForm[];
}

interface BuilderForm {
  name: string;
  clientName: string;
  sections: SectionForm[];
}

function newKey(): string {
  return `k_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function quoteToForm(quote: Quote): BuilderForm {
  return {
    name: quote.name,
    clientName: quote.clientName ?? "",
    sections: quote.sections.map((s) => ({
      key: s.id,
      id: s.id,
      title: s.title,
      lines: s.lines.map((l) => ({
        key: l.id,
        id: l.id,
        kind: l.kind,
        description: l.description,
        qty: String(l.qty),
        unit: l.unit,
        rate: String(l.rate),
      })),
    })),
  };
}

/** "" → 0 (an untouched amount field is an empty line, not an error);
 *  anything unparseable → null (field-level error, save disabled). */
function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Comparable shape for dirty-detection — parsed numbers so "1.0" == 1. */
function comparable(form: BuilderForm) {
  return {
    name: form.name.trim(),
    clientName: form.clientName.trim(),
    sections: form.sections.map((s) => ({
      id: s.id,
      title: s.title.trim(),
      lines: s.lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description.trim(),
        qty: parseAmount(l.qty),
        unit: l.unit.trim(),
        rate: parseAmount(l.rate),
      })),
    })),
  };
}

function validationIssues(form: BuilderForm): string[] {
  const issues: string[] = [];
  if (!form.name.trim()) issues.push("The quote needs a name.");
  form.sections.forEach((s, i) => {
    if (!s.title.trim()) issues.push(`Section ${i + 1} needs a title.`);
    s.lines.forEach((l, j) => {
      const qty = parseAmount(l.qty);
      const rate = parseAmount(l.rate);
      if (qty === null || qty < 0 || qty > QUOTE_LIMITS.maxQty) {
        issues.push(`Section ${i + 1}, line ${j + 1}: quantity must be a number ≥ 0.`);
      }
      if (rate === null || Math.abs(rate) > QUOTE_LIMITS.maxRate) {
        issues.push(`Section ${i + 1}, line ${j + 1}: rate must be a number.`);
      }
    });
  });
  return issues;
}

/** Sections in totals.ts shape; invalid amounts contribute 0 so the live
 *  numbers stay stable while a field is mid-edit. */
function totalsSections(form: BuilderForm) {
  return form.sections.map((s) => ({
    lines: s.lines.map((l) => ({
      qty: parseAmount(l.qty) ?? 0,
      rate: parseAmount(l.rate) ?? 0,
    })),
  }));
}

function toSaveInput(form: BuilderForm, updatedAt: string): QuoteSaveInput {
  return {
    name: form.name.trim(),
    clientName: form.clientName.trim() || undefined,
    sections: form.sections.map((s) => ({
      id: s.id,
      title: s.title.trim(),
      lines: s.lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description.trim(),
        qty: parseAmount(l.qty) ?? 0,
        unit: l.unit.trim(),
        rate: parseAmount(l.rate) ?? 0,
      })),
    })),
    updatedAt,
  };
}

/**
 * After a successful save, adopt the server-minted ids into the CURRENT form
 * without clobbering edits made while the save was in flight. The server maps
 * the submitted array positionally, so sentForm[i][j] ↔ saved.sections[i].lines[j];
 * client keys bridge that mapping onto whatever the form looks like now.
 */
function adoptServerIds(current: SectionForm[], sent: SectionForm[], saved: Quote): SectionForm[] {
  const sectionIdByKey = new Map<string, string>();
  const lineIdByKey = new Map<string, string>();
  sent.forEach((s, i) => {
    const savedSection = saved.sections[i];
    if (!savedSection) return;
    sectionIdByKey.set(s.key, savedSection.id);
    s.lines.forEach((l, j) => {
      const savedLine = savedSection.lines[j];
      if (savedLine) lineIdByKey.set(l.key, savedLine.id);
    });
  });
  return current.map((s) => ({
    ...s,
    id: s.id ?? sectionIdByKey.get(s.key),
    lines: s.lines.map((l) => ({ ...l, id: l.id ?? lineIdByKey.get(l.key) })),
  }));
}

const LINE_KIND_OPTIONS: ReadonlyArray<{ value: QuoteLineKind; label: string }> = [
  { value: "material", label: "Material" },
  { value: "labour", label: "Labour" },
  { value: "other", label: "Other" },
];

const inputClass =
  "h-9 rounded-card border border-border bg-surface px-2.5 text-sm text-text " +
  "focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy";

interface QuoteBuilderClientProps {
  initialQuote: Quote;
}

export function QuoteBuilderClient({ initialQuote }: QuoteBuilderClientProps) {
  const [savedQuote, setSavedQuote] = useState<Quote>(initialQuote);
  const [form, setForm] = useState<BuilderForm>(() => quoteToForm(initialQuote));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictQuote, setConflictQuote] = useState<Quote | null>(null);

  const savedComparable = useMemo(
    () => JSON.stringify(comparable(quoteToForm(savedQuote))),
    [savedQuote]
  );
  const dirty = JSON.stringify(comparable(form)) !== savedComparable;
  const issues = useMemo(() => validationIssues(form), [form]);
  const totals = useMemo(() => computeQuoteTotals(totalsSections(form)), [form]);

  function patchSection(key: string, patch: Partial<SectionForm>) {
    setForm((f) => ({
      ...f,
      sections: f.sections.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    }));
  }

  function patchLine(sectionKey: string, lineKey: string, patch: Partial<LineForm>) {
    setForm((f) => ({
      ...f,
      sections: f.sections.map((s) =>
        s.key === sectionKey
          ? { ...s, lines: s.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l)) }
          : s
      ),
    }));
  }

  function addSection() {
    setForm((f) => ({
      ...f,
      sections: [...f.sections, { key: newKey(), title: "", lines: [] }],
    }));
  }

  function removeSection(key: string) {
    setForm((f) => ({ ...f, sections: f.sections.filter((s) => s.key !== key) }));
  }

  function moveSection(key: string, delta: -1 | 1) {
    setForm((f) => {
      const idx = f.sections.findIndex((s) => s.key === key);
      const target = idx + delta;
      if (idx < 0 || target < 0 || target >= f.sections.length) return f;
      const sections = [...f.sections];
      const [moved] = sections.splice(idx, 1);
      sections.splice(target, 0, moved!);
      return { ...f, sections };
    });
  }

  function addLine(sectionKey: string) {
    setForm((f) => ({
      ...f,
      sections: f.sections.map((s) =>
        s.key === sectionKey
          ? {
              ...s,
              lines: [
                ...s.lines,
                { key: newKey(), kind: "material", description: "", qty: "1", unit: "", rate: "" },
              ],
            }
          : s
      ),
    }));
  }

  function removeLine(sectionKey: string, lineKey: string) {
    setForm((f) => ({
      ...f,
      sections: f.sections.map((s) =>
        s.key === sectionKey ? { ...s, lines: s.lines.filter((l) => l.key !== lineKey) } : s
      ),
    }));
  }

  async function onSave() {
    if (saving || issues.length > 0) return;
    setSaving(true);
    setSaveError(null);
    const sentSections = form.sections;
    const result = await saveQuote(savedQuote.id, toSaveInput(form, savedQuote.updatedAt));
    setSaving(false);

    if (result.ok) {
      const saved = result.data.quote;
      setSavedQuote(saved);
      setConflictQuote(null);
      setForm((f) => ({ ...f, sections: adoptServerIds(f.sections, sentSections, saved) }));
      return;
    }

    if (result.error.status === 409) {
      const parsed = QuoteConflictResponseSchema.safeParse(result.error.body);
      if (parsed.success) {
        setConflictQuote(parsed.data.quote);
        return;
      }
    }
    setSaveError(result.error.message || "Save failed");
  }

  function loadServerCopy() {
    if (!conflictQuote) return;
    setSavedQuote(conflictQuote);
    setForm(quoteToForm(conflictQuote));
    setConflictQuote(null);
    setSaveError(null);
  }

  const chip = saving ? (
    <Pill tone="info" data-testid="quote-builder-save-state">
      Saving…
    </Pill>
  ) : saveError ? (
    <Pill tone="danger" data-testid="quote-builder-save-state">
      Save failed
    </Pill>
  ) : dirty ? (
    <Pill tone="warning" data-testid="quote-builder-save-state">
      Unsaved changes
    </Pill>
  ) : (
    <Pill tone="success" data-testid="quote-builder-save-state">
      Saved
    </Pill>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link
        href={"/v2/quotes" as Route}
        className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"
      >
        ← All quotes
      </Link>

      {conflictQuote ? (
        <Card className="border-amber-200 bg-amber-50" role="alert" data-testid="quote-builder-stale-banner">
          <CardTitle>This quote changed since you loaded it</CardTitle>
          <CardDescription className="mt-1 text-amber-900">
            Someone (or another tab) saved a newer version. Your edits here are NOT saved — load
            the latest version to continue from it. Anything you changed since opening this page
            will be discarded.
          </CardDescription>
          <div className="mt-3">
            <Button data-testid="quote-builder-load-latest" onClick={loadServerCopy}>
              Load latest version
            </Button>
          </div>
        </Card>
      ) : null}

      {saveError ? (
        <Card className="border-rose-200 bg-rose-50" role="alert" data-testid="quote-builder-save-error">
          <CardDescription className="text-rose-900">
            Couldn&rsquo;t save: {saveError}. Your edits are still here — try saving again.
          </CardDescription>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-64 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={quoteStatusTone(savedQuote.status)}>
                {quoteStatusLabel(savedQuote.status)}
              </Pill>
              {chip}
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-text">Quote name</span>
              <input
                data-testid="quote-builder-name"
                value={form.name}
                maxLength={QUOTE_LIMITS.maxName}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className={`${inputClass} max-w-xl`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-text">Client</span>
              <input
                data-testid="quote-builder-client"
                value={form.clientName}
                maxLength={QUOTE_LIMITS.maxClientName}
                placeholder="Optional"
                onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
                className={`${inputClass} max-w-xl`}
              />
            </label>
          </div>

          <div className="flex flex-col items-end gap-3">
            <Button
              data-testid="quote-builder-save"
              onClick={() => void onSave()}
              disabled={saving || !dirty || issues.length > 0}
            >
              {saving ? "Saving…" : "Save quote"}
            </Button>
            <dl className="space-y-1 text-right text-sm" data-testid="quote-builder-totals">
              <div className="flex justify-between gap-6">
                <dt className="text-text-muted">Subtotal ex GST</dt>
                <dd className="tabular-nums font-medium text-text">
                  {formatMoney(totals.subtotalExGst)}
                </dd>
              </div>
              <div className="flex justify-between gap-6">
                <dt className="text-text-muted">GST</dt>
                <dd className="tabular-nums font-medium text-text">{formatMoney(totals.gst)}</dd>
              </div>
              <div className="flex justify-between gap-6 border-t border-border pt-1">
                <dt className="font-medium text-text">Total inc GST</dt>
                <dd
                  className="tabular-nums text-base font-semibold text-text"
                  data-testid="quote-builder-total-inc-gst"
                >
                  {formatMoney(totals.totalIncGst)}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {issues.length > 0 ? (
          <ul className="mt-3 space-y-0.5 border-t border-border pt-3 text-sm text-amber-900">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      {form.sections.length === 0 ? (
        <Card data-testid="quote-builder-no-sections">
          <CardTitle>No sections yet</CardTitle>
          <CardDescription className="mt-1">
            Sections group the work the way the job will run — &ldquo;Switchboard&rdquo;,
            &ldquo;Lighting&rdquo;, &ldquo;Final fit-off&rdquo;. Add the first one to start
            pricing.
          </CardDescription>
        </Card>
      ) : (
        form.sections.map((section, index) => (
          <Card key={section.key} data-testid={`quote-builder-section-${index}`}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Section title"
                placeholder="Section title"
                value={section.title}
                maxLength={QUOTE_LIMITS.maxSectionTitle}
                onChange={(e) => patchSection(section.key, { title: e.target.value })}
                className={`${inputClass} min-w-48 flex-1 font-medium`}
              />
              <span className="text-sm tabular-nums text-text-muted">
                {formatMoney(
                  sectionSubtotal({
                    lines: section.lines.map((l) => ({
                      qty: parseAmount(l.qty) ?? 0,
                      rate: parseAmount(l.rate) ?? 0,
                    })),
                  })
                )}{" "}
                ex GST
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move section ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => moveSection(section.key, -1)}
                >
                  <ArrowUp aria-hidden="true" className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Move section ${index + 1} down`}
                  disabled={index === form.sections.length - 1}
                  onClick={() => moveSection(section.key, 1)}
                >
                  <ArrowDown aria-hidden="true" className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove section ${index + 1}`}
                  onClick={() => removeSection(section.key)}
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {section.lines.length > 0 ? (
              <div className="mt-3 space-y-2">
                <div className="hidden grid-cols-[7.5rem_1fr_5rem_4.5rem_6.5rem_6rem_2rem] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-text-muted md:grid">
                  <span>Kind</span>
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Unit</span>
                  <span>Rate ex GST</span>
                  <span className="text-right">Line total</span>
                  <span />
                </div>
                <ul className="space-y-2">
                  {section.lines.map((line) => {
                    const qty = parseAmount(line.qty);
                    const rate = parseAmount(line.rate);
                    return (
                      <li
                        key={line.key}
                        className="grid grid-cols-2 items-center gap-2 rounded-card border border-border p-2 md:grid-cols-[7.5rem_1fr_5rem_4.5rem_6.5rem_6rem_2rem] md:border-0 md:p-0 md:px-1"
                      >
                        <select
                          aria-label="Line kind"
                          value={line.kind}
                          onChange={(e) =>
                            patchLine(section.key, line.key, {
                              kind: e.target.value as QuoteLineKind,
                            })
                          }
                          className={inputClass}
                        >
                          {LINE_KIND_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label="Line description"
                          placeholder="Description"
                          value={line.description}
                          maxLength={QUOTE_LIMITS.maxLineDescription}
                          onChange={(e) =>
                            patchLine(section.key, line.key, { description: e.target.value })
                          }
                          className={`${inputClass} col-span-2 md:col-span-1`}
                        />
                        <input
                          aria-label="Quantity"
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min={0}
                          value={line.qty}
                          onChange={(e) => patchLine(section.key, line.key, { qty: e.target.value })}
                          className={`${inputClass} ${qty === null || qty < 0 ? "border-state-danger" : ""}`}
                        />
                        <input
                          aria-label="Unit"
                          placeholder="ea"
                          value={line.unit}
                          maxLength={QUOTE_LIMITS.maxUnit}
                          onChange={(e) => patchLine(section.key, line.key, { unit: e.target.value })}
                          className={inputClass}
                        />
                        <input
                          aria-label="Rate ex GST"
                          type="number"
                          inputMode="decimal"
                          step="any"
                          value={line.rate}
                          onChange={(e) => patchLine(section.key, line.key, { rate: e.target.value })}
                          className={`${inputClass} ${rate === null ? "border-state-danger" : ""}`}
                        />
                        <span className="text-right text-sm tabular-nums font-medium text-text">
                          {formatMoney(lineTotal({ qty: qty ?? 0, rate: rate ?? 0 }))}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Remove line"
                          onClick={() => removeLine(section.key, line.key)}
                          className="justify-self-end"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-sm text-text-muted">No line items in this section yet.</p>
            )}

            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                data-testid={`quote-builder-add-line-${index}`}
                onClick={() => addLine(section.key)}
              >
                <Plus aria-hidden="true" className="h-4 w-4" /> Add line
              </Button>
            </div>
          </Card>
        ))
      )}

      <Button variant="secondary" data-testid="quote-builder-add-section" onClick={addSection}>
        <Plus aria-hidden="true" className="h-4 w-4" /> Add section
      </Button>
    </div>
  );
}
