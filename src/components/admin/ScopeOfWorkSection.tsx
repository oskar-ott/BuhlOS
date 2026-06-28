"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { updateJob } from "@/domains/jobs/client";
import type { Job } from "@/domains/jobs/types";
import type { CertaintyState } from "@/domains/jobs/certainty";
import { CertaintyChip } from "./CertaintyChip";
import { cn } from "@/lib/cn";

/**
 * Scope of work editor (#200) — the builder's Basics tab. Deliberately
 * simple: ordered items (title + free-text detail), add / edit / remove /
 * move, saved as ONE full-array PUT (the customFields precedent; the
 * server normalises order + assigns ids). Admin-tier only — the server
 * 403s an LH PUT; LH reads the hub card instead.
 *
 * v1 is capture, nothing more — no takeoff, no import, no rich text.
 * Structure/tasks/quotes build FROM this later (#120 WS1).
 */

interface DraftItem {
  key: string;
  id?: string;
  title: string;
  detail: string;
}

let keyCounter = 0;
const nextKey = () => `sw-draft-${++keyCounter}`;

export function ScopeOfWorkSection({
  job,
  certaintyByClauseId,
  reconciled = false,
  selectedClauseId = null,
  onInspectClause,
}: {
  job: Job;
  /** Per-clause certainty derived from the confirmed reconciliation (clauseId → state). */
  certaintyByClauseId?: ReadonlyMap<string, CertaintyState>;
  /** True when this job has a confirmed reconciliation — gates the certainty chips. */
  reconciled?: boolean;
  /** The clause currently open in the cockpit Inspector, for highlight. */
  selectedClauseId?: string | null;
  /** Open a saved clause in the cockpit Inspector. */
  onInspectClause?: (clauseId: string, title: string, detail: string) => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<DraftItem[]>(() =>
    (job.scopeOfWork ?? [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((i) => ({ key: i.id, id: i.id, title: i.title, detail: i.detail }))
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const patch = (key: string, p: Partial<DraftItem>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)));
    setDirty(true);
    setSavedAt(null);
  };
  const move = (idx: number, dir: -1 | 1) => {
    setItems((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
    setDirty(true);
    setSavedAt(null);
  };

  async function save() {
    setBusy(true);
    setError(null);
    const res = await updateJob({
      id: job.id,
      scopeOfWork: items.map((i) => ({
        id: i.id,
        title: i.title.trim(),
        detail: i.detail,
      })),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setDirty(false);
    setSavedAt(new Date().toISOString());
    router.refresh();
  }

  const valid = items.every((i) => i.title.trim() !== "");

  return (
    <Card role="region" aria-label="Scope of work">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Scope of work</CardTitle>
          <CardDescription className="mt-1">
            What was actually agreed — the one source structure, tasks and the
            quote build from. Office-only; leading hands see it read-only on
            the job hub.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setItems((prev) => [...prev, { key: nextKey(), title: "", detail: "" }]);
            setDirty(true);
          }}
          data-testid="scope-add"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add item
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          No scope captured yet. Add the agreed items — even rough ones beat a
          PDF on someone&rsquo;s desktop.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item, idx) => {
            const cert = item.id ? certaintyByClauseId?.get(item.id) : undefined;
            const showCert = Boolean(item.id && reconciled && cert);
            const selected = Boolean(item.id && selectedClauseId && item.id === selectedClauseId);
            return (
            <li
              key={item.key}
              className={cn(
                "rounded-card border p-3",
                selected ? "border-brand-navy ring-1 ring-brand-navy" : "border-border"
              )}
            >
              <div className="flex items-start gap-2">
                <span className="mt-2 w-5 shrink-0 font-mono text-xs text-text-muted">
                  {idx + 1}.
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  {showCert && cert ? <CertaintyChip cert={cert} /> : null}
                  <input
                    value={item.title}
                    onChange={(e) => patch(item.key, { title: e.target.value })}
                    placeholder="e.g. Supply and install switchboard DB-1"
                    className="h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
                    data-testid={`scope-title-${idx}`}
                  />
                  <textarea
                    value={item.detail}
                    onChange={(e) => patch(item.key, { detail: e.target.value })}
                    placeholder="Detail (optional) — inclusions, exclusions, assumptions"
                    rows={2}
                    className="w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {item.id && onInspectClause ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onInspectClause(item.id!, item.title, item.detail)}
                      aria-label="Inspect scope line"
                      data-testid={`scope-inspect-${idx}`}
                    >
                      <PanelRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Move up">
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(idx, 1)} disabled={idx === items.length - 1} aria-label="Move down">
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setItems((prev) => prev.filter((i) => i.key !== item.key));
                      setDirty(true);
                    }}
                    aria-label="Remove item"
                  >
                    ✕
                  </Button>
                </div>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={busy || !dirty || !valid} data-testid="scope-save">
          {busy ? "Saving…" : "Save scope"}
        </Button>
        {savedAt ? <span className="text-xs text-state-success">Saved.</span> : null}
        {!valid ? (
          <span className="text-xs text-text-muted">Every item needs a title.</span>
        ) : null}
      </div>
    </Card>
  );
}
