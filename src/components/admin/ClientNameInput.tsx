"use client";

import { useEffect, useId, useState } from "react";
import { listJobsSummary } from "@/domains/jobs/client";
import { clientNameSuggestions, canonicalClientName } from "@/domains/jobs/client-names";

/**
 * "Client" — who the job is for, usually the builder (owner pull 2026-10-03).
 * A plain text input with the clients already used on other jobs offered as
 * you type (native <datalist>: a dropdown on desktop, the suggestion bar on a
 * phone keyboard). Pick one, or type a new client — it becomes a suggestion
 * from then on. On blur, a same-client spelling snaps onto the existing one,
 * so "hutchinson builders" never becomes a second client.
 *
 * Suggestions come from the light admin summary read, fetched once per page
 * load and shared by every instance; a failed read just means no
 * suggestions — the field still works as plain text.
 */
let suggestionsOnce: Promise<string[]> | null = null;

function loadSuggestions(): Promise<string[]> {
  if (!suggestionsOnce) {
    suggestionsOnce = listJobsSummary()
      .then((res) => (res.ok ? clientNameSuggestions(res.data.jobs) : []))
      .catch(() => []);
    // A failed read shouldn't stick for the whole session.
    void suggestionsOnce.then((s) => {
      if (s.length === 0) suggestionsOnce = null;
    });
  }
  return suggestionsOnce;
}

export function ClientNameInput({
  value,
  onChange,
  className,
  "data-testid": testId,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  "data-testid"?: string;
}) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void loadSuggestions().then((s) => {
      if (live) setSuggestions(s);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <input
        data-testid={testId}
        className={className}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          const snapped = canonicalClientName(value, suggestions);
          if (snapped !== value) onChange(snapped);
        }}
        autoComplete="off"
        autoCapitalize="words"
        maxLength={120}
        placeholder="e.g. Hutchinson Builders"
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}
