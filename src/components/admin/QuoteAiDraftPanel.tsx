"use client";

import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { runAiQuoteDraft, reviewAiQuoteDraftSuggestion } from "@/domains/quoting/client";
import {
  readAiDraft,
  takeoffToDraftInput,
  SCOPE_TEXT_MAX_CHARS,
  type DraftSuggestion,
  type TakeoffInput,
} from "@/domains/quoting/ai-draft";
import { fetchTakeoff } from "@/domains/ai-drawings/client";
import { QUOTE_LIMITS, type Quote, type QuoteLineKind } from "@/domains/quoting/schema";

/**
 * #246 — "Draft from scope (AI)" on the v2 quote builder. Flag-gated by the
 * parent (`ai_quote_drafts`, dark by default) — this component never renders
 * when the flag is off.
 *
 * Honesty rules baked in:
 *   - paste-first v1: the only input is pasted scope text (PDF text
 *     extraction is not built — the copy says so; no fake upload control)
 *   - no run yet → just the paste form, never a fake draft
 *   - AI unconfigured → the server's 503 is shown plainly
 *   - a truncated run is DISCLOSED ("first 12,000 characters…")
 *   - suggestions never show a price (the model is forbidden from proposing
 *     one); an accepted line lands at $0 with the "AI · needs pricing" badge
 *     in the builder — pricing stays a human decision
 *   - superseded/rejected suggestions are hidden from the tray but stay on
 *     the document for audit (a muted count says so)
 */

const KIND_LABEL: Record<QuoteLineKind, string> = {
  material: "Material",
  labour: "Labour",
  other: "Other",
};

const fieldClass =
  "h-8 rounded-card border border-border bg-surface px-2 text-sm text-text " +
  "focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy";

interface EditDraft {
  suggestionId: string;
  kind: QuoteLineKind;
  description: string;
  qty: string;
  unit: string;
}

interface QuoteAiDraftPanelProps {
  quote: Quote;
  /** Adopt the server's updated document; `acceptedSuggestionId` is set when
   *  a real line was written so the builder can merge it into the open form. */
  onQuoteUpdate: (quote: Quote, acceptedSuggestionId?: string) => void;
}

export function QuoteAiDraftPanel({ quote, onQuoteUpdate }: QuoteAiDraftPanelProps) {
  const aiDraft = useMemo(() => readAiDraft(quote), [quote]);
  const pending = useMemo(
    () => aiDraft.suggestions.filter((s) => s.status === "suggested"),
    [aiDraft]
  );
  const reviewedCount = aiDraft.suggestions.length - pending.length;
  const latestRun = aiDraft.runs.length > 0 ? aiDraft.runs[aiDraft.runs.length - 1] : undefined;

  const [open, setOpen] = useState(pending.length > 0);
  const [sourceText, setSourceText] = useState("");
  // #246 follow-through: a job converted from this quote may carry a
  // SIGNED-OFF Epic 5 takeoff (#213) — offer its measured quantities.
  // Absent store / dark flag / no sign-off ⇒ no offer, never a fake one.
  const linkedJobId =
    typeof (quote as unknown as Record<string, unknown>).convertedJobId === "string"
      ? ((quote as unknown as Record<string, unknown>).convertedJobId as string)
      : null;
  const [takeoffOffer, setTakeoffOffer] = useState<{
    input: TakeoffInput;
    version: number;
    lineCount: number;
    skippedNoQty: number;
  } | null>(null);
  const [useTakeoff, setUseTakeoff] = useState(true);
  useEffect(() => {
    if (!linkedJobId) return;
    let cancelled = false;
    fetchTakeoff(linkedJobId)
      .then((views) => {
        if (cancelled || !views.signedOff) return;
        const mapped = takeoffToDraftInput(views.signedOff);
        if (!mapped.input) return;
        setTakeoffOffer({
          input: mapped.input,
          version: views.signedOff.version,
          lineCount: mapped.input.items.length,
          skippedNoQty: mapped.skippedNoQty,
        });
      })
      .catch(() => {
        // flag-dark (404) or store unreachable (503) — silently no offer
      });
    return () => {
      cancelled = true;
    };
  }, [linkedJobId]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  /** Pending suggestions grouped by proposed section, insertion order kept. */
  const grouped = useMemo(() => {
    const map = new Map<string, DraftSuggestion[]>();
    for (const s of pending) {
      const list = map.get(s.sectionTitle);
      if (list) list.push(s);
      else map.set(s.sectionTitle, [s]);
    }
    return [...map.entries()];
  }, [pending]);

  async function onGenerate() {
    const text = sourceText.trim();
    if (!text || running) return;
    setRunning(true);
    setRunError(null);
    const result = await runAiQuoteDraft(quote.id, {
      sourceText: text,
      ...(takeoffOffer && useTakeoff ? { takeoff: takeoffOffer.input } : {}),
    });
    setRunning(false);
    if (result.ok) {
      onQuoteUpdate(result.data.quote);
      return;
    }
    if (result.error.status === 503) {
      setRunError("AI is not configured — the Anthropic key isn't set for this deployment.");
    } else if (result.error.status === 502) {
      setRunError("The AI reply couldn't be used — nothing was stored. Run it again.");
    } else if (result.error.status === 409) {
      setRunError("This quote changed in another tab while drafting. Reload, then run it again.");
    } else {
      setRunError(result.error.message || "Draft failed");
    }
  }

  async function review(
    suggestion: DraftSuggestion,
    decision: "accept" | "edit" | "reject",
    editedLine?: { kind: QuoteLineKind; description: string; qty: number | null; unit: string | null }
  ) {
    if (busySuggestionId) return;
    setBusySuggestionId(suggestion.id);
    setReviewError(null);
    const result = await reviewAiQuoteDraftSuggestion(quote.id, {
      suggestionId: suggestion.id,
      decision,
      ...(editedLine ? { editedLine } : {}),
    });
    setBusySuggestionId(null);
    if (result.ok) {
      setEditDraft(null);
      onQuoteUpdate(result.data.quote, decision === "reject" ? undefined : suggestion.id);
      return;
    }
    setReviewError(
      result.error.status === 409
        ? "This quote changed in another tab. Reload to continue reviewing."
        : result.error.message || "Review failed"
    );
  }

  function startEdit(s: DraftSuggestion) {
    setEditDraft({
      suggestionId: s.id,
      kind: s.line.kind,
      description: s.line.description,
      qty: s.line.qty === null ? "" : String(s.line.qty),
      unit: s.line.unit ?? "",
    });
    setReviewError(null);
  }

  function submitEdit(s: DraftSuggestion) {
    if (!editDraft) return;
    const description = editDraft.description.trim();
    if (!description) {
      setReviewError("The line needs a description.");
      return;
    }
    let qty: number | null = null;
    const qtyRaw = editDraft.qty.trim();
    if (qtyRaw !== "") {
      const n = Number(qtyRaw);
      if (!Number.isFinite(n) || n < 0) {
        setReviewError("Quantity must be a number ≥ 0, or left blank for none.");
        return;
      }
      qty = n;
    }
    void review(s, "edit", {
      kind: editDraft.kind,
      description,
      qty,
      unit: editDraft.unit.trim() || null,
    });
  }

  return (
    <Card data-testid="quote-ai-draft-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Draft from scope (AI)</CardTitle>
          <CardDescription className="mt-1">
            Paste the tender scope / spec text — PDF text extraction isn&rsquo;t built yet. The AI
            proposes sections and lines only; it never sets a rate or price.
          </CardDescription>
        </div>
        <Button
          variant="secondary"
          size="sm"
          data-testid="quote-ai-draft-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <Sparkles aria-hidden="true" className="h-4 w-4" />{" "}
          {open
            ? "Hide"
            : pending.length > 0
              ? `Review ${pending.length} suggested line${pending.length === 1 ? "" : "s"}`
              : "Draft from scope (AI)"}
        </Button>
      </div>

      {open ? (
        <div className="mt-3 space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-text">Scope / spec text</span>
            <textarea
              data-testid="quote-ai-draft-text"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              rows={6}
              placeholder="Paste the scope of works here…"
              className="rounded-card border border-border bg-surface p-2.5 text-sm text-text focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy"
            />
          </label>
          {takeoffOffer ? (
            <label
              className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text"
              data-testid="quote-ai-draft-takeoff-offer"
            >
              <input
                type="checkbox"
                checked={useTakeoff}
                onChange={(e) => setUseTakeoff(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Include the signed-off drawing takeoff (v{takeoffOffer.version} ·{" "}
              {takeoffOffer.lineCount} measured line{takeoffOffer.lineCount === 1 ? "" : "s"})
              {takeoffOffer.skippedNoQty > 0 ? (
                <span className="text-text-muted">
                  — {takeoffOffer.skippedNoQty} line{takeoffOffer.skippedNoQty === 1 ? "" : "s"}{" "}
                  without a quantity stay out
                </span>
              ) : null}
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="quote-ai-draft-generate"
              onClick={() => void onGenerate()}
              disabled={running || !sourceText.trim()}
            >
              {running ? "Drafting…" : "Generate draft lines"}
            </Button>
            {sourceText.length > SCOPE_TEXT_MAX_CHARS ? (
              <span className="text-xs text-text-muted">
                Long paste — only the first {SCOPE_TEXT_MAX_CHARS.toLocaleString("en-AU")} characters
                will be used.
              </span>
            ) : null}
          </div>

          {runError ? (
            <p className="text-sm text-rose-900" role="alert" data-testid="quote-ai-draft-error">
              {runError}
            </p>
          ) : null}

          {latestRun?.truncated ? (
            <p className="text-xs text-amber-900" data-testid="quote-ai-draft-truncated">
              The last run used only the first{" "}
              {SCOPE_TEXT_MAX_CHARS.toLocaleString("en-AU")} characters of the pasted scope — the
              rest was not read.
            </p>
          ) : null}

          {reviewError ? (
            <p className="text-sm text-rose-900" role="alert" data-testid="quote-ai-review-error">
              {reviewError}
            </p>
          ) : null}

          {pending.length > 0 ? (
            <div className="space-y-3" data-testid="quote-ai-draft-tray">
              {grouped.map(([sectionTitle, suggestions]) => (
                <div key={sectionTitle}>
                  <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                    → {sectionTitle}
                  </p>
                  <ul className="mt-1 space-y-2">
                    {suggestions.map((s) => {
                      const editing = editDraft?.suggestionId === s.id;
                      const busy = busySuggestionId === s.id;
                      return (
                        <li
                          key={s.id}
                          className="rounded-card border border-border p-2.5"
                          data-testid="quote-ai-suggestion"
                        >
                          {editing && editDraft ? (
                            <div className="space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  aria-label="Line kind"
                                  value={editDraft.kind}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, kind: e.target.value as QuoteLineKind })
                                  }
                                  className={fieldClass}
                                >
                                  <option value="material">Material</option>
                                  <option value="labour">Labour</option>
                                  <option value="other">Other</option>
                                </select>
                                <input
                                  aria-label="Line description"
                                  value={editDraft.description}
                                  maxLength={QUOTE_LIMITS.maxLineDescription}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, description: e.target.value })
                                  }
                                  className={`${fieldClass} min-w-48 flex-1`}
                                />
                                <input
                                  aria-label="Quantity"
                                  type="number"
                                  inputMode="decimal"
                                  step="any"
                                  min={0}
                                  placeholder="qty"
                                  value={editDraft.qty}
                                  onChange={(e) => setEditDraft({ ...editDraft, qty: e.target.value })}
                                  className={`${fieldClass} w-20`}
                                />
                                <input
                                  aria-label="Unit"
                                  placeholder="unit"
                                  value={editDraft.unit}
                                  maxLength={QUOTE_LIMITS.maxUnit}
                                  onChange={(e) => setEditDraft({ ...editDraft, unit: e.target.value })}
                                  className={`${fieldClass} w-20`}
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" disabled={busy} onClick={() => submitEdit(s)}>
                                  {busy ? "Adding…" : "Add with changes"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => setEditDraft(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                              <Pill tone="neutral">{KIND_LABEL[s.line.kind]}</Pill>
                              <span className="min-w-40 flex-1 text-sm text-text">
                                {s.line.description}
                              </span>
                              <span className="text-xs tabular-nums text-text-muted">
                                {s.line.qty !== null
                                  ? `${s.line.qty}${s.line.unit ? ` ${s.line.unit}` : ""}`
                                  : "no quantity given"}
                              </span>
                              <span className="flex gap-1.5">
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  data-testid="quote-ai-suggestion-accept"
                                  onClick={() => void review(s, "accept")}
                                >
                                  {busy ? "…" : "Accept"}
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  disabled={busy}
                                  data-testid="quote-ai-suggestion-edit"
                                  onClick={() => startEdit(s)}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  data-testid="quote-ai-suggestion-discard"
                                  onClick={() => void review(s, "reject")}
                                >
                                  Discard
                                </Button>
                              </span>
                              {s.uncertainty ? (
                                <p className="w-full text-xs italic text-amber-900">
                                  Unsure: {s.uncertainty}
                                </p>
                              ) : null}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              <p className="text-xs text-text-muted">
                Accepted lines land in the sections below at $0 with an &ldquo;AI · needs
                pricing&rdquo; badge — you set every rate.
              </p>
            </div>
          ) : latestRun ? (
            <p className="text-sm text-text-muted" data-testid="quote-ai-draft-empty">
              No suggestions waiting for review from the last run.
            </p>
          ) : null}

          {reviewedCount > 0 ? (
            <p className="text-xs text-text-muted" data-testid="quote-ai-draft-reviewed-note">
              {reviewedCount} earlier suggestion{reviewedCount === 1 ? "" : "s"} were reviewed or
              superseded — they stay on the quote&rsquo;s record.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
