"use client";

import { useState } from "react";
import { Check, ClipboardList, Pencil, Plus, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { Takeoff, TakeoffLine, TakeoffViews } from "@/domains/ai-drawings/schema";
import {
  addTakeoffLine,
  adjustTakeoffLine,
  assembleTakeoff,
  signOffTakeoff,
} from "@/domains/ai-drawings/client";

/**
 * Epic 5 (#213) — the takeoff: verified extractions assembled into one
 * signed-off quantity list.
 *
 * Assembly is pure aggregation over the ACCEPTED seams only (verified
 * counts #205, reviewed schedule rows #202/#207, accepted cable estimates
 * #211 — the last stay labelled estimates all the way). Every line carries
 * provenance back to its sheet; duplicate-scope warnings ride along;
 * adjustments are recorded with who/when and win on read. Sign-off freezes
 * the version — the ONLY takeoff Epic 7 quoting may read. Changes after
 * sign-off mean assembling a new version, never editing history.
 */

interface TakeoffLookup {
  labelFor: (planId: string) => string;
}

const SOURCE_LABEL: Record<TakeoffLine["sourceType"], string> = {
  "device-count": "verified count",
  "schedule-row": "schedule",
  "cable-estimate": "cable est.",
  manual: "manual",
  // #882 — the legend schedule's own tabulated quantity, human-accepted.
  "legend-qty": "from the legend",
};

export function TakeoffCard({
  jobId,
  views,
  lookup,
  onViews,
}: {
  jobId: string;
  views: TakeoffViews;
  lookup: TakeoffLookup;
  onViews: (views: TakeoffViews) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const run = async (fn: () => Promise<TakeoffViews>) => {
    setBusy(true);
    setNotice("");
    try {
      onViews(await fn());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Drawing takeoff"
      className="rounded-card border border-border bg-surface"
      data-testid="takeoff-card"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle>Takeoff — verified quantities, signed off</CardTitle>
            <CardDescription className="mt-1">
              Assembles <strong>only</strong> what a human accepted: verified
              counts, reviewed schedule rows, accepted cable estimates (kept
              as estimates). Sign-off freezes a version — the only takeoff
              quoting sees.
            </CardDescription>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => assembleTakeoff(jobId))}
            data-testid="assemble-takeoff"
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-card border px-3 text-sm font-medium",
              busy
                ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
            )}
          >
            <ClipboardList aria-hidden="true" className="h-4 w-4" />
            {views.draft || views.signedOff ? "Re-assemble (new version)" : "Assemble takeoff"}
          </button>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {!views.draft && !views.signedOff ? (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle p-3 text-center text-xs text-text-muted">
            No takeoff yet — verify counts on the sheets first, then assemble.
            Unverified AI output never lands here.
          </p>
        ) : null}

        {views.draft ? (
          <TakeoffSection
            jobId={jobId}
            takeoff={views.draft}
            lookup={lookup}
            busy={busy}
            onViews={onViews}
            onNotice={setNotice}
            onSignOff={() => void run(() => signOffTakeoff(jobId, views.draft!.id))}
          />
        ) : null}

        {views.signedOff ? (
          <TakeoffSection
            jobId={jobId}
            takeoff={views.signedOff}
            lookup={lookup}
            busy={busy}
            onViews={onViews}
            onNotice={setNotice}
          />
        ) : null}

        {notice ? (
          <p className="text-xs text-amber-700" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TakeoffSection({
  jobId,
  takeoff,
  lookup,
  busy,
  onViews,
  onNotice,
  onSignOff,
}: {
  jobId: string;
  takeoff: Takeoff;
  lookup: TakeoffLookup;
  busy: boolean;
  onViews: (views: TakeoffViews) => void;
  onNotice: (notice: string) => void;
  onSignOff?: () => void;
}) {
  const [manualDesc, setManualDesc] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [manualUnit, setManualUnit] = useState("ea");
  const isDraft = takeoff.status === "draft";

  const patchLine = (line: TakeoffLine) => {
    const lines = takeoff.lines.map((l) => (l.id === line.id ? line : l));
    const next = { ...takeoff, lines };
    onViews(
      isDraft
        ? { draft: next, signedOff: null as Takeoff | null }
        : { draft: null, signedOff: next },
    );
  };

  const addManual = async () => {
    const qty = Number(manualQty);
    if (!manualDesc.trim() || !(qty >= 0) || !manualUnit.trim()) return;
    try {
      const out = await addTakeoffLine(jobId, takeoff.id, manualDesc.trim(), qty, manualUnit.trim());
      const next = { ...takeoff, lines: [...takeoff.lines, out.line] };
      onViews({ draft: next, signedOff: null });
      setManualDesc("");
      setManualQty("");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "add failed");
    }
  };

  return (
    <div
      className="rounded-card border border-border"
      data-testid={isDraft ? "takeoff-draft" : "takeoff-signed"}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-text">v{takeoff.version}</span>
        {isDraft ? (
          <Pill tone="warning">draft — not signed off</Pill>
        ) : (
          <Pill tone="success">
            <Check aria-hidden="true" className="mr-1 inline h-3 w-3" />
            signed off · {takeoff.signedOffBy ?? "?"} — the quoting source
          </Pill>
        )}
        <span className="text-xs text-text-muted">
          {takeoff.lines.length} line{takeoff.lines.length === 1 ? "" : "s"}
        </span>
        {isDraft && onSignOff ? (
          <button
            type="button"
            disabled={busy}
            onClick={onSignOff}
            data-testid="sign-off-takeoff"
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-card border border-brand-navy bg-brand-navy px-2.5 text-xs font-medium text-text-inverse hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            Sign off takeoff
          </button>
        ) : null}
      </div>

      {takeoff.warnings.length > 0 ? (
        <div
          className="border-b border-border px-3 py-2 text-xs text-text"
          data-testid="takeoff-warnings"
        >
          {takeoff.warnings.map((w, i) => (
            <p key={i} className="text-amber-700">
              ⚠ {lookup.labelFor(w.planId)} p{w.pageIndex + 1}: {w.detail}
            </p>
          ))}
        </div>
      ) : null}

      <ul className="divide-y divide-border">
        {takeoff.lines.map((line) => (
          <TakeoffLineRow
            key={line.id}
            jobId={jobId}
            line={line}
            editable={isDraft}
            busy={busy}
            lookup={lookup}
            onLine={patchLine}
            onNotice={onNotice}
          />
        ))}
      </ul>

      {isDraft ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs">
          <span className="text-text-muted">Add line:</span>
          <input
            type="text"
            value={manualDesc}
            onChange={(e) => setManualDesc(e.target.value)}
            placeholder="Description…"
            aria-label="Manual line description"
            className="h-6 w-44 rounded-card border border-border bg-surface px-2 text-text"
          />
          <input
            type="number"
            min={0}
            value={manualQty}
            onChange={(e) => setManualQty(e.target.value)}
            placeholder="qty"
            aria-label="Manual line quantity"
            className="h-6 w-16 rounded-card border border-border bg-surface px-2 text-text"
          />
          <input
            type="text"
            value={manualUnit}
            onChange={(e) => setManualUnit(e.target.value)}
            aria-label="Manual line unit"
            className="h-6 w-14 rounded-card border border-border bg-surface px-2 text-text"
          />
          <button
            type="button"
            disabled={busy || !manualDesc.trim() || !(Number(manualQty) >= 0) || !manualQty}
            onClick={() => void addManual()}
            className="inline-flex h-6 items-center gap-1 rounded-card border border-border bg-surface px-2 font-medium text-text hover:bg-surface-subtle disabled:cursor-not-allowed disabled:text-text-muted"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TakeoffLineRow({
  jobId,
  line,
  editable,
  busy,
  lookup,
  onLine,
  onNotice,
}: {
  jobId: string;
  line: TakeoffLine;
  editable: boolean;
  busy: boolean;
  lookup: TakeoffLookup;
  onLine: (line: TakeoffLine) => void;
  onNotice: (notice: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftQty, setDraftQty] = useState(
    line.effectiveQty === null ? "" : String(line.effectiveQty),
  );
  const [draftNote, setDraftNote] = useState("");

  const provenanceText = () => {
    const p = line.provenance as { planId?: string; pageIndex?: number; located?: number };
    if (line.sourceType === "manual") return `added by ${line.adjustedBy ?? "a human"}`;
    if (p.planId === undefined || p.pageIndex === undefined) return "";
    const base = `${lookup.labelFor(p.planId)} p${(p.pageIndex ?? 0) + 1}`;
    // #882 — verified markers spot-check a legend quantity, never replace it.
    if (line.sourceType === "legend-qty" && typeof p.located === "number" && p.located > 0) {
      return `${base} · spot-check: ${p.located} of ${line.qty ?? "?"} located on the sheets`;
    }
    return base;
  };

  const save = async () => {
    const qty = draftQty.trim() === "" ? null : Number(draftQty);
    if (qty !== null && !(qty >= 0)) return;
    try {
      const out = await adjustTakeoffLine(jobId, line.id, qty, draftNote.trim() || undefined);
      onLine(out.line);
      setEditing(false);
      setDraftNote("");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "adjust failed");
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs" data-testid="takeoff-line">
      <span className="min-w-0 flex-1 text-text">{line.description}</span>
      <Pill tone="neutral">{SOURCE_LABEL[line.sourceType]}</Pill>
      {line.estimate ? <Pill tone="warning">estimate</Pill> : null}
      {line.flagged ? <Pill tone="warning">{line.flagReason ?? "flagged"}</Pill> : null}
      <span className="text-text-muted">{provenanceText()}</span>
      {editing ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min={0}
            value={draftQty}
            onChange={(e) => setDraftQty(e.target.value)}
            aria-label={`Adjust quantity for ${line.description}`}
            className="h-6 w-20 rounded-card border border-border bg-surface px-2 text-text"
          />
          <input
            type="text"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            placeholder="why…"
            aria-label="Adjustment note"
            className="h-6 w-28 rounded-card border border-border bg-surface px-2 text-text"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            aria-label="Save adjustment"
            className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text hover:bg-surface-subtle"
          >
            <Check aria-hidden="true" className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            aria-label="Cancel adjustment"
            className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text-muted hover:text-text"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <span
            className={cn(
              "font-semibold",
              line.effectiveQty === null ? "text-amber-700" : "text-text",
            )}
          >
            {line.effectiveQty === null ? "qty?" : `${line.effectiveQty} ${line.unit}`}
          </span>
          {line.humanQty !== null ? (
            <span
              className="text-text-muted"
              title={`assembled ${line.qty ?? "—"}; adjusted by ${line.adjustedBy ?? "?"}${line.note ? ` — ${line.note}` : ""}`}
            >
              (adj. by {line.adjustedBy ?? "?"})
            </span>
          ) : null}
          {editable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraftQty(line.effectiveQty === null ? "" : String(line.effectiveQty));
                setEditing(true);
              }}
              aria-label={`Adjust ${line.description}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text-muted hover:text-text"
            >
              <Pencil aria-hidden="true" className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      )}
    </li>
  );
}
