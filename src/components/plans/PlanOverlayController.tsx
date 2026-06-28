"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MapPin, StickyNote, Minus, MousePointer2, Eye, EyeOff, Trash2, Loader2, Stamp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { NormPoint } from "@/domains/plans/coords";
import type { Plan } from "@/domains/plans/types";
import { PlanViewer, type PlanOverlayGeom } from "./PlanViewer";
import { PlanOverlayLayer } from "./PlanOverlayLayer";
import {
  listMarkups,
  createMarkup,
  updateMarkup,
  archiveMarkup,
  errorText,
} from "@/domains/plan-markups/client";
import {
  activeMarkupsForPage,
  philMarkupsForPage,
  summariseMarkups,
} from "@/domains/plan-markups/service";
import type { DrawingMarkup, MarkupType } from "@/domains/plan-markups/types";

/**
 * Plan Viewer + overlay controller (Plans Phase 2).
 *
 * Owns the markup state for the selected plan and renders the SVG overlay
 * (PlanOverlayLayer) inside PlanViewer. Admin/office get a small toolbar
 * (add pin/note/line, toggle visibleToPhil, archive); Phil is strictly
 * read-only — markers are tappable to read, with no edit controls and no
 * create/toggle/archive paths. Field workers never receive office-only
 * overlays (the API scopes the list; the client re-filters defensively).
 *
 * Original drawings are untouched: every write goes to /api/plan-markups
 * (jobs/<jobId>/drawing-markups.json), never the plan blob.
 */

type Props = { jobId: string; plan: Plan; mode: "admin" | "phil" };
type SaveState = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

const ADD_TOOLS: ReadonlyArray<{ type: MarkupType; label: string; icon: typeof MapPin }> = [
  { type: "pin", label: "Add pin", icon: MapPin },
  { type: "note", label: "Add note", icon: StickyNote },
  { type: "line", label: "Add line", icon: Minus },
];

export function PlanOverlayController({ jobId, plan, mode }: Props) {
  const isAdmin = mode === "admin";
  const [markups, setMarkups] = useState<DrawingMarkup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState<number>(plan.pages[0]?.pageIndex ?? 0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<MarkupType | null>(null);
  const [pending, setPending] = useState<NormPoint[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [labelDraft, setLabelDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");

  // Fetch all markups for this plan (server scopes by role); re-fetch per plan.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setSelectedId(null);
    setAddMode(null);
    setPending([]);
    listMarkups(jobId, plan.id).then((res) => {
      if (cancelled) return;
      if (res.ok) setMarkups(res.data.markups as DrawingMarkup[]);
      else setLoadError(errorText(res.error));
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, plan.id]);

  const onPageChange = useCallback((p: number) => {
    setPageIndex((prev) => (prev === p ? prev : p));
  }, []);

  const pageMarkups = useMemo(
    () =>
      isAdmin
        ? activeMarkupsForPage(markups, plan.id, pageIndex)
        : philMarkupsForPage(markups, plan.id, pageIndex),
    [isAdmin, markups, plan.id, pageIndex],
  );
  const counts = useMemo(() => summariseMarkups(pageMarkups), [pageMarkups]);
  const selected = useMemo(
    () => pageMarkups.find((m) => m.id === selectedId) ?? null,
    [pageMarkups, selectedId],
  );

  // Seed the edit drafts whenever the selection changes.
  useEffect(() => {
    setLabelDraft(selected?.label ?? "");
    setTextDraft(selected?.text ?? "");
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyMutation = useCallback(
    async (run: () => Promise<{ ok: true; markup: DrawingMarkup } | { ok: false; message: string }>) => {
      setSave({ kind: "saving" });
      const r = await run();
      if (r.ok) {
        setMarkups((prev) => {
          const without = prev.filter((m) => m.id !== r.markup.id);
          return [...without, r.markup];
        });
        setSave({ kind: "saved" });
        return r.markup;
      }
      setSave({ kind: "error", message: r.message });
      return null;
    },
    [],
  );

  const onAddPoint = useCallback(
    (p: NormPoint) => {
      if (!isAdmin || !addMode) return;
      if (addMode === "line") {
        if (pending.length === 0) {
          setPending([p]);
          return;
        }
        const points = [{ x: pending[0]!.nx, y: pending[0]!.ny }, { x: p.nx, y: p.ny }];
        setPending([]);
        setAddMode(null);
        void applyMutation(async () => {
          const res = await createMarkup({ jobId, planId: plan.id, pageIndex, type: "line", points });
          return res.ok ? { ok: true, markup: res.data.markup as DrawingMarkup } : { ok: false, message: errorText(res.error) };
        }).then((m) => m && setSelectedId(m.id));
        return;
      }
      // pin / note — create at the clicked point, then select for labelling.
      setAddMode(null);
      void applyMutation(async () => {
        const res = await createMarkup({ jobId, planId: plan.id, pageIndex, type: addMode, x: p.nx, y: p.ny });
        return res.ok ? { ok: true, markup: res.data.markup as DrawingMarkup } : { ok: false, message: errorText(res.error) };
      }).then((m) => m && setSelectedId(m.id));
    },
    [isAdmin, addMode, pending, applyMutation, jobId, plan.id, pageIndex],
  );

  const saveNote = useCallback(async () => {
    if (!selected) return;
    await applyMutation(async () => {
      const res = await updateMarkup(jobId, selected.id, {
        label: labelDraft.trim() || null,
        text: textDraft.trim() || null,
      });
      return res.ok ? { ok: true, markup: res.data.markup as DrawingMarkup } : { ok: false, message: errorText(res.error) };
    });
  }, [selected, applyMutation, jobId, labelDraft, textDraft]);

  const toggleVisible = useCallback(async () => {
    if (!selected) return;
    await applyMutation(async () => {
      const res = await updateMarkup(jobId, selected.id, { visibleToPhil: !selected.visibleToPhil });
      return res.ok ? { ok: true, markup: res.data.markup as DrawingMarkup } : { ok: false, message: errorText(res.error) };
    });
  }, [selected, applyMutation, jobId]);

  // #233 — designate this markup as part of the as-built handover record. The
  // server rejects the patch on an archived plan and gates on canManageJob.
  const toggleAsBuilt = useCallback(async () => {
    if (!selected) return;
    await applyMutation(async () => {
      const res = await updateMarkup(jobId, selected.id, { asBuilt: !selected.asBuilt });
      return res.ok ? { ok: true, markup: res.data.markup as DrawingMarkup } : { ok: false, message: errorText(res.error) };
    });
  }, [selected, applyMutation, jobId]);

  const archiveSelected = useCallback(async () => {
    if (!selected) return;
    setSave({ kind: "saving" });
    const res = await archiveMarkup(jobId, selected.id);
    if (res.ok) {
      setMarkups((prev) => prev.filter((m) => m.id !== selected.id));
      setSelectedId(null);
      setSave({ kind: "saved" });
    } else {
      setSave({ kind: "error", message: errorText(res.error) });
    }
  }, [selected, jobId]);

  return (
    <div className="space-y-3">
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="overlay-toolbar">
          <div className="inline-flex items-center gap-1 rounded-card border border-border bg-surface p-1">
            <Button
              variant={addMode === null ? "primary" : "ghost"}
              size="sm"
              onClick={() => { setAddMode(null); setPending([]); }}
              aria-pressed={addMode === null}
            >
              <MousePointer2 className="h-4 w-4" aria-hidden /> Select
            </Button>
            {ADD_TOOLS.map(({ type, label, icon: Icon }) => (
              <Button
                key={type}
                variant={addMode === type ? "primary" : "ghost"}
                size="sm"
                onClick={() => { setAddMode(type); setPending([]); }}
                aria-pressed={addMode === type}
              >
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </Button>
            ))}
          </div>
          <span className="text-xs text-text-muted" data-testid="overlay-summary">
            {`${counts.total} overlay${counts.total === 1 ? "" : "s"} · ${counts.visibleToPhil} visible to Phil`}
          </span>
          <SaveStatus save={save} />
          {addMode === "line" && pending.length === 1 ? (
            <span className="text-xs text-brand-navy">Tap the line’s end point…</span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted" data-testid="overlay-phil-hint">
          {counts.total === 0
            ? "No site markups on this page."
            : `${counts.total} site markup${counts.total === 1 ? "" : "s"} — tap to read.`}
        </p>
      )}

      {loadError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardDescription className="text-amber-900">
            Couldn&rsquo;t load overlays ({loadError}). The drawing is still shown below.
          </CardDescription>
        </Card>
      ) : null}

      <PlanViewer
        plan={plan}
        onPageChange={onPageChange}
        renderOverlay={(geom: PlanOverlayGeom) => (
          <PlanOverlayLayer
            markups={pageMarkups}
            view={geom.view}
            boxW={geom.boxW}
            boxH={geom.boxH}
            selectedId={selectedId}
            onSelect={setSelectedId}
            addMode={isAdmin ? addMode : null}
            onAddPoint={onAddPoint}
            pendingPoints={pending}
          />
        )}
      />

      {selected ? (
        <Card className="space-y-3" data-testid="overlay-detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="capitalize">{selected.type} overlay</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {/* #233 — as-built designation pill. Carries the revision context
                  so a markup on a superseded plan reads honestly ("As-built
                  · Rev A"), never as a bare flag. Hidden when not flagged. */}
              {selected.asBuilt ? (
                <Pill tone="warning" data-testid="overlay-asbuilt-pill">
                  {asBuiltPillLabel(selected.revision, selected.drawingNumber)}
                </Pill>
              ) : null}
              <Pill tone={selected.visibleToPhil ? "success" : "neutral"}>
                {selected.visibleToPhil ? "Visible to Phil" : "Office only"}
              </Pill>
            </div>
          </div>

          {isAdmin ? (
            <>
              <div className="space-y-2">
                <input
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder="Short label (optional)"
                  maxLength={120}
                  className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
                  aria-label="Markup label"
                />
                <textarea
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  placeholder="Note for this markup (optional)"
                  maxLength={2000}
                  rows={2}
                  className="w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
                  aria-label="Markup note"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={saveNote} disabled={save.kind === "saving"}>
                  Save note
                </Button>
                <Button size="sm" variant="secondary" onClick={toggleVisible} disabled={save.kind === "saving"}>
                  {selected.visibleToPhil ? (
                    <><EyeOff className="h-4 w-4" aria-hidden /> Hide from Phil</>
                  ) : (
                    <><Eye className="h-4 w-4" aria-hidden /> Show to Phil</>
                  )}
                </Button>
                {/* #233 — designate / clear the as-built flag. */}
                <Button
                  size="sm"
                  variant={selected.asBuilt ? "primary" : "secondary"}
                  onClick={toggleAsBuilt}
                  disabled={save.kind === "saving"}
                  aria-pressed={selected.asBuilt === true}
                  data-testid="overlay-asbuilt-toggle"
                >
                  <Stamp className="h-4 w-4" aria-hidden />
                  {selected.asBuilt ? "As-built ✓" : "Mark as-built"}
                </Button>
                <Button size="sm" variant="danger" onClick={archiveSelected} disabled={save.kind === "saving"}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Archive
                </Button>
                <SaveStatus save={save} />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              {selected.label ? <p className="font-medium text-text">{selected.label}</p> : null}
              {selected.text ? (
                <p className="whitespace-pre-wrap text-sm text-text">{selected.text}</p>
              ) : (
                <p className="text-sm text-text-muted">No note on this markup.</p>
              )}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

/**
 * #233 — the as-built pill label, carrying the markup's revision context so a
 * designation on a superseded plan reads honestly. "As-built · Rev A" when a
 * revision is known; "As-built · E-01" when only the drawing number is; plain
 * "As-built" otherwise. Never invents a revision. Exported for the unit test.
 */
export function asBuiltPillLabel(revision?: string, drawingNumber?: string): string {
  const rev = revision?.trim();
  if (rev) return `As-built · Rev ${rev}`;
  const dwg = drawingNumber?.trim();
  if (dwg) return `As-built · ${dwg}`;
  return "As-built";
}

function SaveStatus({ save }: { save: SaveState }) {
  if (save.kind === "idle") return null;
  if (save.kind === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…
      </span>
    );
  }
  if (save.kind === "saved") {
    return <span className="text-xs text-state-success">Saved</span>;
  }
  return (
    <span className={cn("text-xs text-state-danger")} role="alert">
      {save.message ? `Couldn’t save — ${save.message}` : "Couldn’t save"}
    </span>
  );
}
