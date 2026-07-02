"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Pencil,
  RotateCcw,
  ScanSearch,
  X,
} from "lucide-react";
import { z } from "zod";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  SHEET_FIELD_LABELS,
  SHEET_TYPES,
  SHEET_TYPE_LABELS,
  sheetKey,
  type CropRegion,
  type EffectiveSheet,
  type FieldState,
  type SheetField,
  type SheetSpend,
  type SheetType,
} from "@/domains/ai-drawings/schema";
import {
  AiDrawingsError,
  clearOverride,
  fetchSheets,
  saveOverride,
  understandPage,
} from "@/domains/ai-drawings/client";
import { buildRegistryRows } from "@/domains/ai-drawings/registry";
import { SheetRegistryCard } from "@/components/admin/SheetRegistryCard";

/**
 * Epic 5 (#197) — AI sheet understanding: run + review-and-correct loop.
 *
 * Flag-gated (`ai_drawings`, dark) panel on /v2/jobs/[jobId]/documents.
 * The office runs a page-understanding pass over a document's rendered
 * pages (one short vision call per page, client-orchestrated — the
 * Phase-9 pattern), then reviews what the AI read: sheet type + title
 * block, each field with the model's honest confidence. Corrections are
 * stored separately from AI values, always win, and survive re-runs.
 *
 * Honesty (P7): AI values render WITH their confidence; low-confidence
 * fields are flagged needs-review, never silently accepted; absent
 * fields show "—", never invented. Where the extraction store isn't
 * reachable (preview deploys / local dev have no Supabase), the panel
 * says so instead of pretending.
 */

// Minimal view of /api/plans rows — only what this panel needs. The zod
// parse here is deliberately lenient (passthrough on unknown keys).
const PanelPageSchema = z.object({
  pageIndex: z.number().int(),
  pngUrl: z.string(),
  sha256: z.string().optional(),
});
const PanelPlanSchema = z.object({
  id: z.string(),
  title: z.string().optional().default(""),
  fileName: z.string().optional().default(""),
  drawingNumber: z.string().optional().default(""),
  revision: z.string().optional().default(""),
  status: z.string().optional().default("current"),
  pages: z.array(PanelPageSchema).optional().default([]),
});
const PanelPlansResponseSchema = z.object({
  plans: z.array(z.unknown()),
});
type PanelPlan = z.infer<typeof PanelPlanSchema>;

function planLabel(p: PanelPlan): string {
  const name = p.drawingNumber || p.title || p.fileName || p.id;
  return p.revision ? `${name} · Rev ${p.revision}` : name;
}

// Bottom-right quadrant-ish crop — title blocks conventionally live there.
// Reading small title-block text from a high-res crop beats whole-page reads.
const TITLE_BLOCK_REGION: CropRegion = { x: 0.55, y: 0.55, w: 0.45, h: 0.45 };
// Vercel caps serverless request bodies at ~4.5MB — stay safely under it
// (the API's own 6M guard is the ceiling, not the target).
const MAX_CROP_CHARS = 4_000_000;

async function buildTitleBlockCrop(
  pngUrl: string,
): Promise<{ dataUrl: string; region: CropRegion } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = pngUrl;
    });
    const sx = Math.floor(img.naturalWidth * TITLE_BLOCK_REGION.x);
    const sy = Math.floor(img.naturalHeight * TITLE_BLOCK_REGION.y);
    const sw = Math.floor(img.naturalWidth * TITLE_BLOCK_REGION.w);
    const sh = Math.floor(img.naturalHeight * TITLE_BLOCK_REGION.h);
    if (sw < 32 || sh < 32) return null;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/") || dataUrl.length > MAX_CROP_CHARS) {
      return null;
    }
    return { dataUrl, region: TITLE_BLOCK_REGION };
  } catch {
    // CORS-tainted canvas or load failure — analyse the whole page only.
    return null;
  }
}

type PanelStatus = "loading" | "unavailable" | "error" | "ready";

interface RunState {
  planId: string;
  done: number;
  total: number;
}

export function SheetUnderstandingPanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [sheets, setSheets] = useState<Record<string, EffectiveSheet>>({});
  const [reviewThreshold, setReviewThreshold] = useState(0.8);
  const [model, setModel] = useState<string>("");
  const [spend, setSpend] = useState<SheetSpend | null>(null);
  const [plans, setPlans] = useState<PanelPlan[]>([]);
  const [running, setRunning] = useState<RunState | null>(null);
  const [runNotice, setRunNotice] = useState<string>("");

  const applySheet = useCallback((sheet: EffectiveSheet | null) => {
    if (!sheet) return;
    setSheets((prev) => ({
      ...prev,
      [sheetKey(sheet.planId, sheet.pageIndex)]: sheet,
    }));
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    setStatusMessage("");
    try {
      const [sheetsRes, plansRes] = await Promise.all([
        fetchSheets(jobId),
        fetch(`/api/plans?jobId=${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        }).then(async (r) => {
          if (!r.ok) throw new Error(`Documents API ${r.status}`);
          return PanelPlansResponseSchema.parse(await r.json());
        }),
      ]);
      const nextSheets: Record<string, EffectiveSheet> = {};
      for (const s of sheetsRes.sheets) {
        nextSheets[sheetKey(s.planId, s.pageIndex)] = s;
      }
      const parsedPlans: PanelPlan[] = [];
      for (const raw of plansRes.plans) {
        const p = PanelPlanSchema.safeParse(raw);
        if (p.success && p.data.pages.length > 0 && p.data.status !== "archived") {
          parsedPlans.push(p.data);
        }
      }
      setSheets(nextSheets);
      setReviewThreshold(sheetsRes.reviewThreshold);
      setModel(sheetsRes.model);
      setSpend(sheetsRes.spend);
      setPlans(parsedPlans);
      setStatus("ready");
    } catch (err) {
      if (err instanceof AiDrawingsError && err.code === "STORE_UNAVAILABLE") {
        setStatus("unavailable");
        setStatusMessage(err.message);
      } else {
        setStatus("error");
        setStatusMessage(err instanceof Error ? err.message : "Network error");
      }
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPlan = useCallback(
    async (plan: PanelPlan) => {
      setRunNotice("");
      setRunning({ planId: plan.id, done: 0, total: plan.pages.length });
      const failures: string[] = [];
      try {
        for (let i = 0; i < plan.pages.length; i += 1) {
          const page = plan.pages[i];
          if (!page) continue;
          try {
            const crop = await buildTitleBlockCrop(page.pngUrl);
            const out = await understandPage(
              jobId,
              plan.id,
              page.pageIndex,
              crop ?? undefined,
            );
            applySheet(out.sheet);
            if (out.spend) setSpend(out.spend);
          } catch (err) {
            if (err instanceof AiDrawingsError && err.code === "CAP_REACHED") {
              setRunNotice(err.message);
              return; // budget spent — stop the whole run honestly
            }
            failures.push(
              `page ${page.pageIndex + 1}: ${err instanceof Error ? err.message : "failed"}`,
            );
          } finally {
            setRunning((r) =>
              r && r.planId === plan.id ? { ...r, done: i + 1 } : r,
            );
          }
        }
        if (failures.length > 0) {
          setRunNotice(
            `Some pages didn't analyse — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ""}`,
          );
        }
      } finally {
        setRunning(null);
      }
    },
    [applySheet, jobId],
  );

  const totals = useMemo(() => {
    const rows = Object.values(sheets);
    return {
      analysed: rows.length,
      needsReview: rows.filter((s) => s.needsReview).length,
    };
  }, [sheets]);

  // #199: the searchable registry is a projection over the same data the
  // review loop maintains — corrections flow through automatically.
  const registryRows = useMemo(
    () =>
      buildRegistryRows(
        Object.values(sheets),
        plans.map((p) => ({
          id: p.id,
          label: planLabel(p),
          status: p.status,
          pages: p.pages.map((pg) => ({ pageIndex: pg.pageIndex, pngUrl: pg.pngUrl })),
        })),
      ),
    [sheets, plans],
  );

  if (status === "unavailable") {
    return (
      <Card>
        <CardTitle>AI sheet understanding</CardTitle>
        <CardDescription className="mt-1">
          The extraction store isn&rsquo;t reachable in this environment
          {statusMessage ? <> — {statusMessage}</> : null}. Nothing is analysed
          or shown here until it is.
        </CardDescription>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>AI sheet understanding</CardTitle>
          <CardDescription className="mt-1">
            Reads each page&rsquo;s sheet type + title block (number, title,
            rev, scale) so later AI features know which drawing they&rsquo;re
            on. Every value shows the model&rsquo;s confidence — correct
            anything it got wrong; your corrections always win.
          </CardDescription>
        </div>
        {spend ? <SpendMeter spend={spend} /> : null}
      </div>

      {status === "loading" ? (
        <p className="mt-3 text-sm text-text-muted" role="status">
          Loading sheet understanding…
        </p>
      ) : null}

      {status === "error" ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load sheet understanding — {statusMessage}.{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}

      {status === "ready" ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span>
              {totals.analysed} page{totals.analysed === 1 ? "" : "s"} analysed
            </span>
            {totals.needsReview > 0 ? (
              <Pill tone="warning">{totals.needsReview} need review</Pill>
            ) : totals.analysed > 0 ? (
              <Pill tone="success">all reviewed / confident</Pill>
            ) : null}
            {model ? (
              <span className="truncate">model: {model}</span>
            ) : null}
          </div>

          {runNotice ? (
            <p
              className="mt-2 rounded-card border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
              role="alert"
            >
              {runNotice}
            </p>
          ) : null}

          {registryRows.length > 0 ? (
            <div className="mt-3">
              <SheetRegistryCard rows={registryRows} />
            </div>
          ) : null}

          {plans.length === 0 ? (
            <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted">
              No documents with rendered pages yet — upload a PDF drawing set
              first; its pages render on upload.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {plans.map((plan) => (
                <PlanSheets
                  key={plan.id}
                  jobId={jobId}
                  plan={plan}
                  sheets={sheets}
                  running={running}
                  reviewThreshold={reviewThreshold}
                  onRun={() => void runPlan(plan)}
                  onSheet={applySheet}
                  anyRunning={running !== null}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </Card>
  );
}

function SpendMeter({ spend }: { spend: SheetSpend }) {
  const pct = Math.min(100, Math.round((spend.totalUsd / spend.capUsd) * 100));
  // Inline styles are banned (rebuild non-negotiable) — quantise the fill to
  // static Tailwind width classes; the exact figure is in the text above.
  const fill =
    pct >= 100
      ? "w-full"
      : pct >= 88
        ? "w-11/12"
        : pct >= 75
          ? "w-3/4"
          : pct >= 50
            ? "w-1/2"
            : pct >= 25
              ? "w-1/4"
              : pct >= 8
                ? "w-1/12"
                : pct > 0
                  ? "w-1"
                  : "w-0";
  return (
    <div className="w-44 shrink-0" aria-label="AI budget used on this job">
      <div className="flex items-baseline justify-between text-xs text-text-muted">
        <span>AI budget</span>
        <span>
          ${spend.totalUsd.toFixed(2)} / ${spend.capUsd.toFixed(0)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-surface-subtle">
        <div
          className={cn(
            "h-full rounded-pill",
            fill,
            pct >= 90 ? "bg-amber-500" : "bg-brand-navy",
          )}
        />
      </div>
    </div>
  );
}

function PlanSheets({
  jobId,
  plan,
  sheets,
  running,
  reviewThreshold,
  onRun,
  onSheet,
  anyRunning,
}: {
  jobId: string;
  plan: PanelPlan;
  sheets: Record<string, EffectiveSheet>;
  running: RunState | null;
  reviewThreshold: number;
  onRun: () => void;
  onSheet: (sheet: EffectiveSheet | null) => void;
  anyRunning: boolean;
}) {
  const planRunning = running?.planId === plan.id;
  const analysed = plan.pages.filter(
    (p) => sheets[sheetKey(plan.id, p.pageIndex)],
  ).length;
  return (
    <section
      aria-label={`Sheet understanding for ${planLabel(plan)}`}
      className="rounded-card border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-semibold text-text">
            {planLabel(plan)}
          </p>
          <p className="text-xs text-text-muted">
            {plan.pages.length} page{plan.pages.length === 1 ? "" : "s"} ·{" "}
            {analysed} analysed
            {plan.status !== "current" ? ` · ${plan.status}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={anyRunning}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-card border px-3 text-sm font-medium transition-colors",
            anyRunning
              ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
              : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
          )}
        >
          <ScanSearch aria-hidden="true" className="h-4 w-4" />
          {planRunning
            ? `Analysing ${running!.done}/${running!.total}…`
            : analysed === plan.pages.length && analysed > 0
              ? "Re-check pages"
              : "Analyse pages"}
        </button>
      </div>
      <ul className="divide-y divide-border">
        {plan.pages.map((page) => {
          const sheet = sheets[sheetKey(plan.id, page.pageIndex)];
          return (
            <li key={page.pageIndex} className="px-4 py-3">
              <SheetRow
                jobId={jobId}
                planId={plan.id}
                pageIndex={page.pageIndex}
                pngUrl={page.pngUrl}
                sheet={sheet}
                reviewThreshold={reviewThreshold}
                onSheet={onSheet}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SheetRow({
  jobId,
  planId,
  pageIndex,
  pngUrl,
  sheet,
  reviewThreshold,
  onSheet,
}: {
  jobId: string;
  planId: string;
  pageIndex: number;
  pngUrl: string;
  sheet: EffectiveSheet | undefined;
  reviewThreshold: number;
  onSheet: (sheet: EffectiveSheet | null) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">
          Page {pageIndex + 1}
        </span>
        {sheet?.needsReview ? (
          <Pill tone="warning">
            <AlertTriangle aria-hidden="true" className="mr-1 inline h-3 w-3" />
            needs review
          </Pill>
        ) : null}
        {!sheet ? <Pill tone="neutral">not analysed</Pill> : null}
        <a
          href={pngUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-text-muted underline decoration-dotted underline-offset-2 hover:text-text"
          aria-label={`Open page ${pageIndex + 1} image (opens in a new tab)`}
        >
          view page
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </div>
      {sheet ? (
        <>
          <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <FieldEditor
              jobId={jobId}
              sheet={sheet}
              field="sheetType"
              state={sheet.fields.sheetType}
              reviewThreshold={reviewThreshold}
              onSheet={onSheet}
            />
            <FieldEditor
              jobId={jobId}
              sheet={sheet}
              field="sheetNumber"
              state={sheet.fields.sheetNumber}
              reviewThreshold={reviewThreshold}
              onSheet={onSheet}
            />
            <FieldEditor
              jobId={jobId}
              sheet={sheet}
              field="sheetTitle"
              state={sheet.fields.sheetTitle}
              reviewThreshold={reviewThreshold}
              onSheet={onSheet}
            />
            <FieldEditor
              jobId={jobId}
              sheet={sheet}
              field="revision"
              state={sheet.fields.revision}
              reviewThreshold={reviewThreshold}
              onSheet={onSheet}
            />
            <FieldEditor
              jobId={jobId}
              sheet={sheet}
              field="scale"
              state={sheet.fields.scale}
              reviewThreshold={reviewThreshold}
              onSheet={onSheet}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-text-muted">
            read by {sheet.model ?? "AI"} ({sheet.promptVersion ?? "?"})
          </p>
        </>
      ) : null}
    </div>
  );
}

function confidenceLabel(c: number | null | undefined): string {
  if (c === null || c === undefined) return "?";
  return `${Math.round(c * 100)}%`;
}

function FieldEditor({
  jobId,
  sheet,
  field,
  state,
  reviewThreshold,
  onSheet,
}: {
  jobId: string;
  sheet: EffectiveSheet;
  field: SheetField;
  state: FieldState;
  reviewThreshold: number;
  onSheet: (sheet: EffectiveSheet | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const label = SHEET_FIELD_LABELS[field];
  const isType = field === "sheetType";
  const effectiveDisplay =
    state.effective === null
      ? "—"
      : isType
        ? (SHEET_TYPE_LABELS[state.effective as SheetType] ?? state.effective)
        : state.effective;
  const lowConfidence =
    !state.override &&
    (state.ai?.confidence === null ||
      state.ai?.confidence === undefined ||
      state.ai.confidence < reviewThreshold);

  const begin = () => {
    setDraft(state.effective ?? "");
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const value = draft.trim() === "" ? null : draft.trim();
      const out = await saveOverride(jobId, sheet.planId, sheet.pageIndex, field, value);
      onSheet(out.sheet);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await clearOverride(jobId, sheet.planId, sheet.pageIndex, field);
      onSheet(out.sheet);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted">
        <span>{label}</span>
        {state.override ? (
          <Pill tone="info">corrected</Pill>
        ) : state.ai ? (
          <Pill tone={lowConfidence ? "warning" : "neutral"}>
            {confidenceLabel(state.ai.confidence)}
          </Pill>
        ) : null}
      </div>
      {!editing ? (
        <div className="mt-0.5 flex items-start gap-1.5">
          <span
            className={cn(
              "break-words text-sm",
              state.effective === null ? "text-text-muted" : "text-text",
            )}
          >
            {effectiveDisplay}
          </span>
          <button
            type="button"
            onClick={begin}
            aria-label={`Correct ${label} on page ${sheet.pageIndex + 1}`}
            className="mt-0.5 shrink-0 text-text-muted hover:text-text"
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          {state.override ? (
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy}
              aria-label={`Reset ${label} to the AI value`}
              title={`AI read: ${state.ai?.value ?? "—"} (${confidenceLabel(state.ai?.confidence)})`}
              className="mt-0.5 shrink-0 text-text-muted hover:text-text"
            >
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1.5">
          {isType ? (
            <select
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`New ${label}`}
              className="h-8 min-w-0 flex-1 rounded-card border border-border bg-surface px-2 text-sm"
            >
              {SHEET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SHEET_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
              aria-label={`New ${label} (empty = field is absent)`}
              placeholder="empty = absent"
              maxLength={200}
              className="h-8 min-w-0 flex-1 rounded-card border border-border bg-surface px-2 text-sm"
            />
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || (isType && draft === "")}
            aria-label={`Save ${label}`}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-brand-navy bg-brand-navy text-text-inverse disabled:opacity-50"
          >
            <Check aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            aria-label={`Cancel editing ${label}`}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-border bg-surface text-text"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}
      {error ? (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
