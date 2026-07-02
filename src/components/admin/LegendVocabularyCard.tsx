"use client";

import { useMemo, useState } from "react";
import { Check, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  LEGEND_CATEGORIES,
  type LegendCategory,
  type LegendEntry,
} from "@/domains/ai-drawings/schema";
import {
  addLegendEntry,
  reviewLegendEntry,
} from "@/domains/ai-drawings/client";

/**
 * Epic 5 (#201) — the project's symbol vocabulary, reviewed.
 *
 * Every consultant's legend redefines the symbols, so this job's vocabulary
 * — not a generic one — is what device recognition (#204/#205) will consume.
 * AI-extracted entries arrive as SUGGESTIONS (with confidence + the symbol
 * crop where the browser could produce one) and become vocabulary only when
 * a human accepts, edits, or rejects them. Missed entries can be added by
 * hand; rejected labels never resurrect on re-extraction. Downstream
 * consumers read accepted/edited entries ONLY.
 */
export function LegendVocabularyCard({
  jobId,
  entries,
  onEntry,
}: {
  jobId: string;
  entries: LegendEntry[];
  onEntry: (entry: LegendEntry | null) => void;
}) {
  const [showRejected, setShowRejected] = useState(false);

  const live = useMemo(
    () => entries.filter((e) => e.status !== "rejected" && e.status !== "superseded"),
    [entries],
  );
  const rejected = useMemo(
    () => entries.filter((e) => e.status === "rejected"),
    [entries],
  );
  const toReview = useMemo(
    () => live.filter((e) => e.status === "suggested").length,
    [live],
  );
  const grouped = useMemo(() => {
    const order = [...LEGEND_CATEGORIES, null] as Array<string | null>;
    return order
      .map((cat) => ({
        category: cat,
        rows: live.filter((e) => (e.category ?? null) === cat),
      }))
      .filter((g) => g.rows.length > 0);
  }, [live]);

  return (
    <section
      aria-label="Legend vocabulary"
      className="rounded-card border border-border bg-surface"
      data-testid="legend-vocabulary"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Legend vocabulary</CardTitle>
        <CardDescription className="mt-1">
          This project&rsquo;s symbol language, read off its legend sheets.
          Device recognition will only trust entries a human has accepted —
          review the suggestions, fix labels, add anything the AI missed.
        </CardDescription>
        <p className="mt-2 text-xs text-text-muted" role="status">
          {live.length} entr{live.length === 1 ? "y" : "ies"}
          {toReview > 0 ? ` · ${toReview} awaiting review` : live.length > 0 ? " · all reviewed" : ""}
        </p>
      </div>

      {live.length === 0 ? (
        <p className="p-4 text-center text-sm text-text-muted">
          No legend entries yet — run &ldquo;Extract legend&rdquo; on a legend
          sheet below, or add entries by hand.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {grouped.map((g) => (
            <div key={g.category ?? "uncategorised"} className="px-4 py-2.5">
              <h4 className="text-[11px] uppercase tracking-wider text-text-muted">
                {g.category ?? "Uncategorised"}
              </h4>
              <ul className="mt-1.5 space-y-2">
                {g.rows.map((e) => (
                  <LegendRow key={e.id} jobId={jobId} entry={e} onEntry={onEntry} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 ? (
        <div className="border-t border-border px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowRejected((v) => !v)}
            aria-expanded={showRejected}
            className="inline-flex items-center gap-1 text-xs font-medium text-text-muted underline decoration-dotted underline-offset-2 hover:text-text"
          >
            {showRejected ? "Hide" : "Show"} {rejected.length} rejected
            <ChevronRight
              aria-hidden="true"
              className={cn("h-3.5 w-3.5 transition-transform", showRejected ? "rotate-90" : "")}
            />
          </button>
          {showRejected ? (
            <ul className="mt-2 space-y-1">
              {rejected.map((e) => (
                <li key={e.id} className="text-xs text-text-muted line-through">
                  {e.effectiveLabel}
                  {e.reviewNote ? <span className="no-underline"> — {e.reviewNote}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <AddEntryForm jobId={jobId} onEntry={onEntry} />
    </section>
  );
}

function confidencePct(c: number | null): string {
  return c === null ? "?" : `${Math.round(c * 100)}%`;
}

function LegendRow({
  jobId,
  entry,
  onEntry,
}: {
  jobId: string;
  entry: LegendEntry;
  onEntry: (entry: LegendEntry | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const act = async (
    status: "accepted" | "edited" | "rejected",
    humanLabel?: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const out = await reviewLegendEntry(jobId, entry.id, status, humanLabel ? { humanLabel } : {});
      onEntry(out.entry);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "review failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="legend-row">
      <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-card border border-border bg-surface-subtle">
        {entry.symbolCropUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- tiny blob-hosted crop, next/image adds nothing here
          <img
            src={entry.symbolCropUrl}
            alt={`Symbol for ${entry.effectiveLabel}`}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span
            className="px-1 text-center text-[9px] leading-tight text-text-muted"
            title={entry.symbolText ?? undefined}
          >
            {entry.symbolText ? "sym" : "—"}
          </span>
        )}
      </span>

      {!editing ? (
        <span className="min-w-0 flex-1">
          <span className="break-words text-sm font-medium text-text">
            {entry.effectiveLabel}
          </span>
          {entry.description ? (
            <span className="ml-2 text-xs text-text-muted">{entry.description}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) void act("edited", draft.trim());
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label={`Corrected label for ${entry.label}`}
            maxLength={120}
            className="h-8 min-w-0 flex-1 rounded-card border border-border bg-surface px-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void act("edited", draft.trim())}
            disabled={busy || !draft.trim()}
            aria-label="Save corrected label"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-brand-navy bg-brand-navy text-text-inverse disabled:opacity-50"
          >
            <Check aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            aria-label="Cancel edit"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-border bg-surface text-text"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </span>
      )}

      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        {entry.origin === "ai" && entry.status === "suggested" ? (
          <Pill tone="warning">review · {confidencePct(entry.confidence)}</Pill>
        ) : null}
        {entry.status === "accepted" ? <Pill tone="success">accepted</Pill> : null}
        {entry.status === "edited" ? <Pill tone="info">edited</Pill> : null}
        {entry.origin === "human" ? <Pill tone="neutral">added by hand</Pill> : null}
      </span>

      {!editing ? (
        <span className="flex shrink-0 items-center gap-1">
          {entry.status === "suggested" ? (
            <>
              <button
                type="button"
                onClick={() => void act("accepted")}
                disabled={busy}
                aria-label={`Accept "${entry.effectiveLabel}"`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-card border border-border text-text hover:bg-surface-subtle"
              >
                <Check aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(entry.effectiveLabel);
                  setError("");
                  setEditing(true);
                }}
                disabled={busy}
                aria-label={`Correct the label "${entry.effectiveLabel}"`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-card border border-border text-text hover:bg-surface-subtle"
              >
                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
          {entry.status !== "rejected" ? (
            <button
              type="button"
              onClick={() => void act("rejected")}
              disabled={busy}
              aria-label={`Reject "${entry.effectiveLabel}" as bogus`}
              className="inline-flex h-7 w-7 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      ) : null}

      {error ? (
        <p className="w-full text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function AddEntryForm({
  jobId,
  onEntry,
}: {
  jobId: string;
  onEntry: (entry: LegendEntry | null) => void;
}) {
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<LegendCategory | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError("");
    try {
      const out = await addLegendEntry(jobId, label.trim(), {
        category: category || null,
      });
      onEntry(out.entry);
      setLabel("");
      setCategory("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="Add an entry the AI missed…"
          aria-label="New legend entry label"
          maxLength={120}
          className="h-9 min-w-0 flex-1 rounded-card border border-border bg-surface px-3 text-sm sm:max-w-xs"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as LegendCategory | "")}
          aria-label="Category for the new entry"
          className="h-9 rounded-card border border-border bg-surface px-2 text-sm"
        >
          <option value="">Category…</option>
          {LEGEND_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || !label.trim()}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-card border px-3 text-sm font-medium",
            busy || !label.trim()
              ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
              : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
          )}
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
