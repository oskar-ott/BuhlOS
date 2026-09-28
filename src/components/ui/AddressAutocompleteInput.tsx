"use client";

import { useEffect, useRef, useState } from "react";
import {
  ADDRESS_SUGGEST_MIN_CHARS,
  buildAddressSuggestUrl,
  mergePickedAddress,
  parseAddressSuggestions,
  type AddressSuggestion,
} from "@/domains/jobs/address-suggest";
import { cn } from "@/lib/cn";

/**
 * Site-address input with search-as-you-type suggestions (shared: admin
 * forms + the Phil new-job sheet).
 *
 * Free text always wins: suggestions are a convenience to avoid typos, not a
 * gate — whatever ends up in the field is what gets saved. Lookups are
 * debounced, aborted when stale, and any network failure silently degrades
 * to a plain input. Suggestion source/format: src/domains/jobs/address-suggest.ts.
 *
 * The dropdown anchors to the nearest positioned ancestor. Standalone use
 * needs no setup (the default wrapper is `relative`); to anchor it to a
 * decorated container instead (icon + input in one box, as on Phil), mark
 * that container `relative` and pass e.g. wrapperClassName="static flex-1".
 */
export function AddressAutocompleteInput({
  value,
  onChange,
  placeholder,
  className,
  wrapperClassName = "relative",
  id,
  maxLength,
  "data-testid": testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
  id?: string;
  maxLength?: number;
  "data-testid"?: string;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The value the field MOUNTED with counts as already chosen: a saved address
  // must not fetch suggestions and pop the list open on page load (it did — the
  // builder opened with the dropdown covering the date fields, 2026-09-27
  // phone audit). Suggestions are for what the user is typing now.
  const lastPicked = useRef<string | null>(value.trim() || null);
  const latestQuery = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const q = value.trim();
    latestQuery.current = q;
    if (q.length < ADDRESS_SUGGEST_MIN_CHARS || q === lastPicked.current) {
      setSuggestions([]);
      setOpen(false);
      setActive(-1);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(buildAddressSuggestUrl(q), { signal: ctrl.signal });
        if (!res.ok) return;
        const list = parseAddressSuggestions(await res.json());
        if (latestQuery.current !== q) return; // stale response — a newer query owns the box
        setSuggestions(list);
        // Only open under a field the user is actually in: a value that changes
        // while the input is unfocused (a save re-syncing the form, a preset
        // filling the address) must not raise the list over the fields below.
        const focused =
          typeof document !== "undefined" && document.activeElement === inputRef.current;
        setOpen(list.length > 0 && focused);
        setActive(-1);
      } catch {
        // Aborted or offline — leave the field as a plain text input.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pick(s: AddressSuggestion) {
    const next = mergePickedAddress(value, s);
    lastPicked.current = next;
    onChange(next);
    setSuggestions([]);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className={wrapperClassName}>
      <input
        ref={inputRef}
        id={id}
        maxLength={maxLength}
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? "address-suggestions" : undefined}
        autoComplete="off"
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && suggestions.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => (i + 1) % suggestions.length);
          } else if (e.key === "ArrowUp" && open) {
            e.preventDefault();
            setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
          } else if (e.key === "Enter" && open && active >= 0) {
            const s = suggestions[active];
            if (s) {
              // Claim Enter for the pick so it can't double as form submit.
              e.preventDefault();
              e.stopPropagation();
              pick(s);
            }
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {open ? (
        <ul
          id="address-suggestions"
          role="listbox"
          data-testid="address-suggestions"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-card border border-border bg-surface py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li key={s.label} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn(
                  "w-full px-3 py-2 text-left text-sm text-text",
                  i === active ? "bg-surface-subtle" : "hover:bg-surface-subtle"
                )}
                // preventDefault keeps focus in the input so onBlur can't
                // close the list before this click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
