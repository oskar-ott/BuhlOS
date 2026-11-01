"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { fieldChoices, normaliseValue, STOCK_TYPES, typeOf, valueKey, type SpecField } from "@/domains/workshop-stock/types";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { FIELD, FieldLabel, Tag } from "./ui";

/**
 * "What is it?" and the fields that type needs (Workshop Stock) — the switch's
 * range, gang and colour; the LED strip's colour temperature, voltage, width,
 * length. One tap on a chip fills a field (the shop's own values come first,
 * then the common ones); anything can be typed, and is tidied the way a sparky
 * writes it when the field is left ("2g" → "2 gang", "4000k" → "4000K").
 *
 * Brand and colour are the item's own columns: they appear here, among the
 * type's fields, and the parent keeps them in its own state (`values.brand`,
 * `values.colourFinish`). A value read from the label photo is tagged so —
 * check it.
 */
export function TypeFields({
  category,
  onCategory,
  values,
  onValue,
  items,
  readFromPhoto,
  categoryFromPhoto = false,
  disabled = false,
}: {
  category: string | null;
  onCategory: (key: string | null) => void;
  /** field key → value (brand / colourFinish included) */
  values: Record<string, string>;
  onValue: (key: string, value: string) => void;
  items: readonly StockItem[];
  /** field keys whose value came from the label photo (tagged until changed) */
  readFromPhoto?: ReadonlySet<string>;
  categoryFromPhoto?: boolean;
  disabled?: boolean;
}) {
  const type = typeOf(category);
  return (
    <div className="space-y-3" data-testid="stock-type-fields">
      <fieldset>
        <legend className="flex items-center text-sm font-semibold text-text">
          What is it?
          {categoryFromPhoto && category ? <Tag>Read from photo</Tag> : null}
        </legend>
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Type of item">
          {STOCK_TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onCategory(category === t.key ? null : t.key)}
              aria-pressed={category === t.key}
              disabled={disabled}
              className={cn("min-h-[40px] rounded-pill border px-3 text-sm font-semibold", category === t.key ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border-strong bg-surface text-text")}
              data-testid={`stock-type-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </fieldset>
      {type ? (
        <div className="space-y-3 rounded-[14px] border border-border p-3" data-testid="stock-type-field-list">
          {type.fields.map((f) => (
            <SpecInput
              key={`${type.key}-${f.key}`}
              field={f}
              value={values[f.key] ?? ""}
              onChange={(v) => onValue(f.key, v)}
              choices={fieldChoices(type, f, items, 8)}
              tag={readFromPhoto?.has(f.key) && values[f.key] ? <Tag>Read from photo</Tag> : null}
              disabled={disabled}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SpecInput({ field, value, onChange, choices, tag, disabled }: { field: SpecField; value: string; onChange: (v: string) => void; choices: string[]; tag?: ReactNode; disabled: boolean }) {
  const id = `stock-spec-${field.key}`;
  const chosen = valueKey(value);
  return (
    <div>
      <FieldLabel htmlFor={id} tag={tag}>{field.label}</FieldLabel>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { const t = normaliseValue(field, value); if (t !== value) onChange(t); }}
        placeholder={field.placeholder ?? (choices[0] ? `e.g. ${choices[0]}` : "")}
        autoComplete="off"
        disabled={disabled}
        className={cn(FIELD, "h-11")}
        data-testid={`stock-spec-${field.key}`}
      />
      {choices.length ? (
        <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label={`${field.label} choices`}>
          {choices.map((c) => {
            const on = chosen === valueKey(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => onChange(on ? "" : c)}
                aria-pressed={on}
                disabled={disabled}
                className={cn("min-h-[36px] shrink-0 whitespace-nowrap rounded-pill border px-3 text-[13px] font-semibold", on ? "border-brand-navy bg-brand-navy text-text-inverse" : "border-border bg-surface text-text hover:border-brand-navy")}
              >
                {c}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
