"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  RotateCcw,
  ScanSearch,
  X,
} from "lucide-react";
import { z } from "zod";
import { Bar } from "@/components/ui/Bar";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  fetchDocumentBuffer,
  prepareImagePlanPage,
  preparePdfPlanPages,
} from "@/domains/documents/page-prep";
import {
  SHEET_FIELD_LABELS,
  SHEET_TYPES,
  SHEET_TYPE_LABELS,
  sheetKey,
  type CropRegion,
  type EffectiveSheet,
  type FieldState,
  DETECTION_TILES,
  type CountReviewPage,
  type DeviceDetection,
  type EntityLink,
  type SheetRef,
  type TakeoffViews,
  type DiffRegion,
  type LegendEntry,
  type PageDiff,
  type ScheduleRow,
  type ScheduleTable,
  type ScheduleTableKind,
  type SheetField,
  type SheetSpend,
  type SheetType,
} from "@/domains/ai-drawings/schema";
import {
  AiDrawingsError,
  attachLegendCrop,
  clearOverride,
  detectDevices,
  diffPages,
  extractLegend,
  extractRefs,
  extractRooms,
  extractSchedule,
  fetchCountReview,
  fetchLinks,
  fetchTakeoff,
  fetchDetections,
  fetchDiffs,
  fetchLegend,
  fetchSchedules,
  fetchSheets,
  saveOverride,
  understandPage,
} from "@/domains/ai-drawings/client";
import { buildRegistryRows } from "@/domains/ai-drawings/registry";
import { cropRegionFromPng, padRegion } from "@/domains/ai-drawings/crop";
import { SheetRegistryCard } from "@/components/admin/SheetRegistryCard";
import { LegendVocabularyCard } from "@/components/admin/LegendVocabularyCard";
import { ScheduleTablesCard } from "@/components/admin/ScheduleTablesCard";
import { RevisionDiffCard, type RevisionPair } from "@/components/admin/RevisionDiffCard";
import { DeviceDetectionCard } from "@/components/admin/DeviceDetectionCard";
import { DeviceCountReviewCard } from "@/components/admin/DeviceCountReviewCard";
import { CrossSheetLinksCard } from "@/components/admin/CrossSheetLinksCard";
import { TakeoffCard } from "@/components/admin/TakeoffCard";

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
  supersedes: z.string().optional().default(""),
  pages: z.array(PanelPageSchema).optional().default([]),
  // For the retro "Prepare pages" path — the stored file + its type.
  url: z.string().optional().default(""),
  mimeType: z.string().optional().default(""),
});
const PanelPlansResponseSchema = z.object({
  plans: z.array(z.unknown()),
});
type PanelPlan = z.infer<typeof PanelPlanSchema>;

function planLabel(p: PanelPlan): string {
  const name = p.drawingNumber || p.title || p.fileName || p.id;
  return p.revision ? `${name} · Rev ${p.revision}` : name;
}

/**
 * Split the register into what analysis can work on vs what it can't YET.
 * Analysis runs off page images, so a document without prepared pages is
 * unanalysable — previously those rows were silently dropped here, which read
 * as "only some of my documents can be analysed" with no explanation. Now they
 * surface as `unprepared` with a retro "Prepare pages" path. Archived rows
 * stay out of both buckets. Exported for tests.
 */
export function partitionPanelPlans(rows: PanelPlan[]): {
  ready: PanelPlan[];
  unprepared: PanelPlan[];
} {
  const ready: PanelPlan[] = [];
  const unprepared: PanelPlan[] = [];
  for (const p of rows) {
    if (p.status === "archived") continue;
    if (p.pages.length > 0) ready.push(p);
    else unprepared.push(p);
  }
  return { ready, unprepared };
}

/** Can the retro prep path render this document? (PDF via pdf.js; image via
 *  canvas re-encode.) Anything else is honestly not preparable client-side. */
function prepKind(p: PanelPlan): "pdf" | "image" | null {
  const mime = p.mimeType.toLowerCase();
  if (mime === "application/pdf" || /\.pdf$/i.test(p.fileName)) return "pdf";
  if (mime.startsWith("image/")) return "image";
  return null;
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
  const dataUrl = await cropRegionFromPng(pngUrl, TITLE_BLOCK_REGION, MAX_CROP_CHARS);
  return dataUrl ? { dataUrl, region: TITLE_BLOCK_REGION } : null;
}

const MAX_SYMBOL_CROP_CHARS = 1_200_000; // stay under the API's 1.5M guard

type PanelStatus = "loading" | "unavailable" | "error" | "ready";

interface RunState {
  planId: string;
  done: number;
  total: number;
}

export function SheetUnderstandingPanel({
  jobId,
  onRoomsChanged,
}: {
  jobId: string;
  /** Fired after an analysis maps new rooms — lets a sibling accept surface
   *  (the builder's Plan Studio) refetch instead of going stale. Optional;
   *  omitted on the documents page, where no sibling consumes it. */
  onRoomsChanged?: () => void;
}) {
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [sheets, setSheets] = useState<Record<string, EffectiveSheet>>({});
  const [reviewThreshold, setReviewThreshold] = useState(0.8);
  const [model, setModel] = useState<string>("");
  const [spend, setSpend] = useState<SheetSpend | null>(null);
  const [plans, setPlans] = useState<PanelPlan[]>([]);
  // Documents the register holds but analysis can't see yet (no page images) —
  // surfaced with a retro "Prepare pages" action instead of silently dropped.
  const [unpreparedPlans, setUnpreparedPlans] = useState<PanelPlan[]>([]);
  const [prepBusyId, setPrepBusyId] = useState<string | null>(null);
  const [prepProgress, setPrepProgress] = useState<{ done: number; total: number } | null>(null);
  const [prepErrors, setPrepErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<RunState | null>(null);
  const [runNotice, setRunNotice] = useState<string>("");
  const [legendEntries, setLegendEntries] = useState<LegendEntry[]>([]);
  const [scheduleTables, setScheduleTables] = useState<ScheduleTable[]>([]);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>([]);
  const [scheduleColumns, setScheduleColumns] = useState<Record<string, string[]>>({});
  const [pageDiffs, setPageDiffs] = useState<PageDiff[]>([]);
  const [diffRegions, setDiffRegions] = useState<DiffRegion[]>([]);
  const [deviceDetections, setDeviceDetections] = useState<DeviceDetection[]>([]);
  const [countPages, setCountPages] = useState<CountReviewPage[]>([]);
  const [sheetRefs, setSheetRefs] = useState<SheetRef[]>([]);
  const [entityLinks, setEntityLinks] = useState<EntityLink[]>([]);
  const [takeoffViews, setTakeoffViews] = useState<TakeoffViews>({ draft: null, signedOff: null });
  const [comparing, setComparing] = useState<{ headPlanId: string; done: number; total: number } | null>(null);
  // one page-level extraction (legend OR schedule) at a time
  const [extractBusyKey, setExtractBusyKey] = useState<string | null>(null);

  const applySheet = useCallback((sheet: EffectiveSheet | null) => {
    if (!sheet) return;
    setSheets((prev) => ({
      ...prev,
      [sheetKey(sheet.planId, sheet.pageIndex)]: sheet,
    }));
  }, []);

  const applyLegendEntry = useCallback((entry: LegendEntry | null) => {
    if (!entry) return;
    setLegendEntries((prev) => {
      const i = prev.findIndex((e) => e.id === entry.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, []);

  const applyScheduleRow = useCallback((row: ScheduleRow) => {
    setScheduleRows((prev) => {
      const i = prev.findIndex((r) => r.id === row.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = row;
        return next;
      }
      return [...prev, row];
    });
  }, []);

  const applyDiffRegion = useCallback((region: DiffRegion) => {
    setDiffRegions((prev) => {
      const i = prev.findIndex((r) => r.id === region.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = region;
        return next;
      }
      return [...prev, region];
    });
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    setStatusMessage("");
    try {
      const [
        sheetsRes,
        plansRes,
        legendRes,
        schedulesRes,
        diffsRes,
        detectionsRes,
        countRes,
        linksRes,
        takeoffRes,
      ] = await Promise.all([
        fetchSheets(jobId),
        fetch(`/api/plans?jobId=${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          credentials: "same-origin",
        }).then(async (r) => {
          if (!r.ok) throw new Error(`Documents API ${r.status}`);
          return PanelPlansResponseSchema.parse(await r.json());
        }),
        fetchLegend(jobId),
        fetchSchedules(jobId),
        fetchDiffs(jobId),
        fetchDetections(jobId),
        fetchCountReview(jobId),
        fetchLinks(jobId),
        fetchTakeoff(jobId),
      ]);
      const nextSheets: Record<string, EffectiveSheet> = {};
      for (const s of sheetsRes.sheets) {
        nextSheets[sheetKey(s.planId, s.pageIndex)] = s;
      }
      const parsedPlans: PanelPlan[] = [];
      for (const raw of plansRes.plans) {
        const p = PanelPlanSchema.safeParse(raw);
        if (p.success) parsedPlans.push(p.data);
      }
      const { ready, unprepared } = partitionPanelPlans(parsedPlans);
      setSheets(nextSheets);
      setReviewThreshold(sheetsRes.reviewThreshold);
      setModel(sheetsRes.model);
      setSpend(sheetsRes.spend);
      setPlans(ready);
      setUnpreparedPlans(unprepared);
      setLegendEntries(legendRes.entries);
      setScheduleTables(schedulesRes.tables);
      setScheduleRows(schedulesRes.rows);
      setScheduleColumns(schedulesRes.columns);
      setPageDiffs(diffsRes.diffs);
      setDiffRegions(diffsRes.regions);
      setDeviceDetections(detectionsRes.detections);
      setCountPages(countRes.pages);
      setSheetRefs(linksRes.refs);
      setEntityLinks(linksRes.links);
      setTakeoffViews(takeoffRes);
      setStatus("ready");
    } catch (err) {
      if (
        err instanceof AiDrawingsError &&
        (err.code === "STORE_UNAVAILABLE" || err.code === "UNCONFIGURED")
      ) {
        // Both are "this environment can't run AI" states with an honest,
        // actionable message (missing store vs missing ANTHROPIC_API_KEY) —
        // show the message rather than a generic error.
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

  /** Retro page-prep for a document analysis can't see yet: fetch the stored
   *  file, render it to page PNGs client-side (the same helper the uploader
   *  uses), register them, then reload — the document moves into the
   *  analysable list. Failures land next to the row, never silently. */
  const runPreparePages = useCallback(
    async (plan: PanelPlan) => {
      const kind = prepKind(plan);
      setPrepErrors((prev) => ({ ...prev, [plan.id]: "" }));
      if (!plan.url || !kind) {
        setPrepErrors((prev) => ({
          ...prev,
          [plan.id]: !plan.url
            ? "This document has no stored file URL — re-upload it."
            : "This file type can't be rendered to pages here (PDF or image only).",
        }));
        return;
      }
      setPrepBusyId(plan.id);
      setPrepProgress(null);
      try {
        if (kind === "pdf") {
          const buffer = await fetchDocumentBuffer(plan.url);
          await preparePdfPlanPages(jobId, plan.id, buffer, (page, total) =>
            setPrepProgress({ done: page, total }),
          );
        } else {
          const res = await fetch(plan.url, { credentials: "omit", cache: "no-store" });
          if (!res.ok) throw new Error(`couldn't fetch the file (${res.status})`);
          await prepareImagePlanPage(jobId, plan.id, await res.blob());
        }
        await load();
      } catch (err) {
        setPrepErrors((prev) => ({
          ...prev,
          [plan.id]: err instanceof Error ? err.message : "page preparation failed",
        }));
      } finally {
        setPrepBusyId(null);
        setPrepProgress(null);
      }
    },
    [jobId, load],
  );

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

  // #201: one legend-extraction call per page; symbol crops attach after,
  // best-effort (a CORS-tainted canvas just means label-only entries).
  const runExtractLegend = useCallback(
    async (plan: PanelPlan, pageIndex: number) => {
      const page = plan.pages.find((p) => p.pageIndex === pageIndex);
      if (!page) return;
      setRunNotice("");
      setExtractBusyKey(sheetKey(plan.id, pageIndex));
      try {
        const out = await extractLegend(jobId, plan.id, pageIndex);
        setLegendEntries(out.entries);
        if (out.spend) setSpend(out.spend);
        if (!out.isLegendPresent) {
          setRunNotice(`No legend found on page ${pageIndex + 1} of ${planLabel(plan)}.`);
        }
        const targets = out.entries.filter(
          (e) =>
            e.symbolCropUrl === null &&
            e.cropRegion !== null &&
            e.sourcePlanId === plan.id &&
            e.sourcePageIndex === pageIndex,
        );
        for (const t of targets) {
          const dataUrl = await cropRegionFromPng(
            page.pngUrl,
            padRegion(t.cropRegion!),
            MAX_SYMBOL_CROP_CHARS,
            16,
          );
          if (!dataUrl) continue;
          try {
            const res2 = await attachLegendCrop(jobId, t.id, dataUrl);
            applyLegendEntry(res2.entry);
          } catch {
            // best-effort — the label-only entry stands
          }
        }
      } catch (err) {
        if (err instanceof AiDrawingsError && err.code === "CAP_REACHED") {
          setRunNotice(err.message);
        } else {
          setRunNotice(err instanceof Error ? err.message : "legend extraction failed");
        }
      } finally {
        setExtractBusyKey(null);
      }
    },
    [applyLegendEntry, jobId],
  );

  // #202/#207: one schedule-extraction call per page — same rhythm as legend.
  const runExtractSchedule = useCallback(
    async (plan: PanelPlan, pageIndex: number, kind: ScheduleTableKind) => {
      setRunNotice("");
      setExtractBusyKey(sheetKey(plan.id, pageIndex));
      try {
        const out = await extractSchedule(jobId, plan.id, pageIndex, kind);
        setScheduleTables(out.tables);
        setScheduleRows(out.rows);
        if (out.spend) setSpend(out.spend);
        if (!out.isSchedulePresent) {
          setRunNotice(
            `No ${kind === "lighting" ? "lighting" : "switchboard"} schedule found on page ${pageIndex + 1} of ${planLabel(plan)}.`,
          );
        }
      } catch (err) {
        if (err instanceof AiDrawingsError && err.code === "CAP_REACHED") {
          setRunNotice(err.message);
        } else {
          setRunNotice(err instanceof Error ? err.message : "schedule extraction failed");
        }
      } finally {
        setExtractBusyKey(null);
      }
    },
    [jobId],
  );

  // #203: candidate revision pairs from the register's supersede lineage;
  // pages pair by index (manual pairing can come later if sheets move pages).
  const revisionPairs = useMemo<RevisionPair[]>(() => {
    const byId = new Map(plans.map((p) => [p.id, p]));
    const pairs: RevisionPair[] = [];
    for (const head of plans) {
      if (!head.supersedes || head.pages.length === 0) continue;
      const base = byId.get(head.supersedes);
      if (!base || base.pages.length === 0) continue;
      pairs.push({
        headPlanId: head.id,
        basePlanId: base.id,
        headLabel: planLabel(head),
        baseLabel: planLabel(base),
        pageCount: Math.min(head.pages.length, base.pages.length),
      });
    }
    return pairs;
  }, [plans]);

  const runComparePair = useCallback(
    async (pair: RevisionPair) => {
      setRunNotice("");
      setComparing({ headPlanId: pair.headPlanId, done: 0, total: pair.pageCount });
      const failures: string[] = [];
      try {
        for (let i = 0; i < pair.pageCount; i += 1) {
          try {
            await diffPages(
              jobId,
              { planId: pair.basePlanId, pageIndex: i },
              { planId: pair.headPlanId, pageIndex: i },
            );
          } catch (err) {
            failures.push(`p${i + 1}: ${err instanceof Error ? err.message : "failed"}`);
          } finally {
            setComparing((c) =>
              c && c.headPlanId === pair.headPlanId ? { ...c, done: i + 1 } : c,
            );
          }
        }
        const diffsRes = await fetchDiffs(jobId);
        setPageDiffs(diffsRes.diffs);
        setDiffRegions(diffsRes.regions);
        if (failures.length > 0) {
          setRunNotice(
            `Some pages couldn't be compared — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? ` (+${failures.length - 3} more)` : ""}`,
          );
        }
      } finally {
        setComparing(null);
      }
    },
    [jobId],
  );

  // #212: one refs pass per analysed page of a document (cached by sha —
  // an unchanged page never bills twice).
  const runFindRefs = useCallback(
    async (plan: PanelPlan) => {
      setRunNotice("");
      setExtractBusyKey(sheetKey(plan.id, -1));
      try {
        let found = 0;
        for (const page of plan.pages) {
          try {
            const out = await extractRefs(jobId, plan.id, page.pageIndex);
            found += out.inserted;
            if (out.spend) setSpend(out.spend);
          } catch (err) {
            if (err instanceof AiDrawingsError && err.code === "CAP_REACHED") {
              setRunNotice(err.message);
              return;
            }
            setRunNotice(
              `Page ${page.pageIndex + 1} refs failed — ${err instanceof Error ? err.message : "error"}; continuing.`,
            );
          }
        }
        const linksRes = await fetchLinks(jobId);
        setSheetRefs(linksRes.refs);
        setEntityLinks(linksRes.links);
        setRunNotice(
          found > 0
            ? `Found ${found} cross-sheet reference${found === 1 ? "" : "s"} — see References & links.`
            : "No new cross-sheet references found (cached pages stay free).",
        );
      } finally {
        setExtractBusyKey(null);
      }
    },
    [jobId],
  );

  // #206: one whole-page vision pass for room labels + approximate extents.
  const runExtractRooms = useCallback(
    async (plan: PanelPlan, pageIndex: number) => {
      setRunNotice("");
      setExtractBusyKey(sheetKey(plan.id, pageIndex));
      try {
        const out = await extractRooms(jobId, plan.id, pageIndex);
        setCountPages((prev) => {
          const i = prev.findIndex(
            (p) => p.planId === out.page.planId && p.pageIndex === out.page.pageIndex,
          );
          if (i < 0) return [...prev, out.page];
          const next = [...prev];
          next[i] = out.page;
          return next;
        });
        if (out.spend) setSpend(out.spend);
        setRunNotice(
          out.cached
            ? "Rooms already mapped for this sheet (cached — no new AI spend)."
            : `Mapped ${out.inserted} room${out.inserted === 1 ? "" : "s"} — approximate boxes; review them in the counts card.`,
        );
        // New rooms exist server-side — let the sibling accept surface refetch.
        onRoomsChanged?.();
      } catch (err) {
        setRunNotice(err instanceof Error ? err.message : "Room mapping failed");
      } finally {
        setExtractBusyKey(null);
      }
    },
    [jobId, onRoomsChanged],
  );

  // #204: tile the page in the browser (overlapping 2×2) and run one vision
  // call per tile — the server dedupes seam duplicates by IoU.
  const runDetectDevices = useCallback(
    async (plan: PanelPlan, pageIndex: number) => {
      const page = plan.pages.find((p) => p.pageIndex === pageIndex);
      if (!page) return;
      setRunNotice("");
      setExtractBusyKey(sheetKey(plan.id, pageIndex));
      try {
        for (let i = 0; i < DETECTION_TILES.length; i += 1) {
          const region = DETECTION_TILES[i]!;
          const dataUrl = await cropRegionFromPng(page.pngUrl, region, 3_600_000, 64);
          if (!dataUrl) {
            setRunNotice(
              "Couldn't crop tiles in this browser (image blocked) — detection needs the tile crops.",
            );
            return;
          }
          try {
            await detectDevices(jobId, plan.id, pageIndex, { region, dataUrl });
          } catch (err) {
            if (err instanceof AiDrawingsError && (err.code === "CAP_REACHED" || err.status === 409)) {
              setRunNotice(err.message);
              return; // budget spent or no reviewed vocabulary — stop honestly
            }
            setRunNotice(
              `Tile ${i + 1}/${DETECTION_TILES.length} failed — ${err instanceof Error ? err.message : "error"}; continuing.`,
            );
          }
        }
        const [detectionsRes, countRes, spendRes] = await Promise.all([
          fetchDetections(jobId),
          fetchCountReview(jobId),
          fetchSheets(jobId),
        ]);
        setDeviceDetections(detectionsRes.detections);
        setCountPages(countRes.pages);
        setSpend(spendRes.spend);
      } finally {
        setExtractBusyKey(null);
      }
    },
    [jobId],
  );

  const totals = useMemo(() => {
    const rows = Object.values(sheets);
    return {
      analysed: rows.length,
      needsReview: rows.filter((s) => s.needsReview).length,
    };
  }, [sheets]);

  // Show the vocabulary once there is anything to review or any legend sheet
  // to extract from — an empty card on a job with no legends is just noise.
  const legendRelevant = useMemo(
    () =>
      legendEntries.length > 0 ||
      Object.values(sheets).some((s) => s.fields.sheetType.effective === "legend"),
    [legendEntries, sheets],
  );

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
    // Show the ACTUAL reason unwrapped — the message is already a complete,
    // actionable sentence (missing ANTHROPIC_API_KEY vs no extraction store).
    // Wrapping every case in store phrasing mis-diagnosed a missing key as a
    // store problem.
    return (
      <Card>
        <CardTitle>Plan analysis</CardTitle>
        <CardDescription className="mt-1">
          {statusMessage
            ? `Not available here: ${statusMessage}`
            : "Not available in this environment."}{" "}
          Nothing is analysed or shown until it is.
        </CardDescription>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Plan analysis</CardTitle>
          <CardDescription className="mt-1">
            Analyse a plan to read its title block (number, title, rev, scale)
            and suggest rooms and fittings. Every value shows the model&rsquo;s
            confidence — correct anything it got wrong; your corrections always
            win.
          </CardDescription>
        </div>
        {spend ? <SpendMeter spend={spend} /> : null}
      </div>

      {status === "loading" ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-text-muted" role="status">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Loading plan analysis…
        </p>
      ) : null}

      {status === "error" ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load plan analysis — {statusMessage}.{" "}
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

          {legendRelevant ? (
            <div className="mt-3">
              <LegendVocabularyCard
                jobId={jobId}
                entries={legendEntries}
                onEntry={applyLegendEntry}
              />
            </div>
          ) : null}

          {revisionPairs.length > 0 || pageDiffs.length > 0 ? (
            <div className="mt-3">
              <RevisionDiffCard
                jobId={jobId}
                diffs={pageDiffs}
                regions={diffRegions}
                pairs={revisionPairs}
                comparing={comparing}
                onComparePair={(pair) => void runComparePair(pair)}
                lookup={{
                  pngUrlFor: (planId, pageIndex) =>
                    plans
                      .find((p) => p.id === planId)
                      ?.pages.find((pg) => pg.pageIndex === pageIndex)?.pngUrl ?? null,
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                }}
                onRegion={applyDiffRegion}
              />
            </div>
          ) : null}

          {countPages.length > 0 ? (
            <div className="mt-3">
              <DeviceCountReviewCard
                jobId={jobId}
                pages={countPages}
                vocabulary={legendEntries.filter(
                  (e) => e.status === "accepted" || e.status === "edited",
                )}
                lookup={{
                  pngUrlFor: (planId, pageIndex) =>
                    plans
                      .find((p) => p.id === planId)
                      ?.pages.find((pg) => pg.pageIndex === pageIndex)?.pngUrl ?? null,
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                }}
                onPage={(page) =>
                  setCountPages((prev) => {
                    const i = prev.findIndex(
                      (p) => p.planId === page.planId && p.pageIndex === page.pageIndex,
                    );
                    if (i < 0) return [...prev, page];
                    const next = [...prev];
                    next[i] = page;
                    return next;
                  })
                }
              />
            </div>
          ) : null}

          {countPages.length > 0 || takeoffViews.draft || takeoffViews.signedOff ? (
            <div className="mt-3">
              <TakeoffCard
                jobId={jobId}
                views={takeoffViews}
                lookup={{
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                }}
                onViews={setTakeoffViews}
              />
            </div>
          ) : null}

          {(sheetRefs.length > 0 || entityLinks.length > 0 || scheduleTables.length > 0 || countPages.length > 0) ? (
            <div className="mt-3">
              <CrossSheetLinksCard
                jobId={jobId}
                refs={sheetRefs}
                links={entityLinks}
                lookup={{
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                  pageOptions: plans.flatMap((p) =>
                    p.pages.map((pg) => ({
                      planId: p.id,
                      pageIndex: pg.pageIndex,
                      label: `${planLabel(p)} p${pg.pageIndex + 1}`,
                    })),
                  ),
                }}
                onLinks={(links) => {
                  setEntityLinks(links);
                  // link changes can flip duplicate-count warnings — refresh
                  void fetchCountReview(jobId).then((r) => setCountPages(r.pages)).catch(() => {});
                }}
              />
            </div>
          ) : null}

          {deviceDetections.length > 0 ? (
            <div className="mt-3">
              <DeviceDetectionCard
                detections={deviceDetections}
                lookup={{
                  pngUrlFor: (planId, pageIndex) =>
                    plans
                      .find((p) => p.id === planId)
                      ?.pages.find((pg) => pg.pageIndex === pageIndex)?.pngUrl ?? null,
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                }}
              />
            </div>
          ) : null}

          {scheduleTables.length > 0 ? (
            <div className="mt-3">
              <ScheduleTablesCard
                jobId={jobId}
                tables={scheduleTables}
                rows={scheduleRows}
                columns={scheduleColumns}
                lookup={{
                  pngUrlFor: (planId, pageIndex) =>
                    plans
                      .find((p) => p.id === planId)
                      ?.pages.find((pg) => pg.pageIndex === pageIndex)?.pngUrl ?? null,
                  labelFor: (planId) => {
                    const p = plans.find((pl) => pl.id === planId);
                    return p ? planLabel(p) : "(document no longer on this job)";
                  },
                }}
                onRow={applyScheduleRow}
              />
            </div>
          ) : null}

          {plans.length === 0 ? (
            <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-center text-sm text-text-muted">
              {unpreparedPlans.length > 0
                ? "No documents are analysable yet — the ones below need their pages prepared first."
                : "No documents with rendered pages yet — upload a PDF drawing set first; its pages render on upload."}
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
                  anyRunning={running !== null || extractBusyKey !== null}
                  extractBusyKey={extractBusyKey}
                  onExtractLegend={(pageIndex) => void runExtractLegend(plan, pageIndex)}
                  onExtractSchedule={(pageIndex, kind) =>
                    void runExtractSchedule(plan, pageIndex, kind)
                  }
                  onDetectDevices={(pageIndex) => void runDetectDevices(plan, pageIndex)}
                  onExtractRooms={(pageIndex) => void runExtractRooms(plan, pageIndex)}
                  onFindRefs={() => void runFindRefs(plan)}
                />
              ))}
            </div>
          )}
          {/* OUTSIDE the plans.length branch on purpose: when EVERY document is
              page-less (uploads from the broken-pdf.js window), this section is
              the only way out — it must render even when the registry is empty. */}
          {unpreparedPlans.length > 0 ? (
            <section
              aria-label="Documents not ready to analyse"
              className="mt-3 rounded-card border border-border bg-surface"
              data-testid="unprepared-plans"
            >
                  <div className="border-b border-border px-4 py-3">
                    <CardTitle>
                      Not ready to analyse ({unpreparedPlans.length})
                    </CardTitle>
                    <CardDescription className="mt-1">
                      These documents have no page images yet, so the analysis
                      can&rsquo;t see them — usually older uploads or image files.
                      The files themselves are saved; prepare pages to make them
                      analysable.
                    </CardDescription>
                  </div>
                  <ul className="divide-y divide-border">
                    {unpreparedPlans.map((p) => {
                      const busy = prepBusyId === p.id;
                      const error = prepErrors[p.id];
                      return (
                        <li
                          key={p.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-text">
                              {planLabel(p)}
                            </p>
                            {p.fileName && p.fileName !== planLabel(p) ? (
                              <p className="truncate text-xs text-text-muted">{p.fileName}</p>
                            ) : null}
                            {error ? (
                              <p className="text-xs text-state-danger" role="alert">
                                {error}
                              </p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => void runPreparePages(p)}
                            disabled={prepBusyId !== null}
                            className={cn(
                              "inline-flex h-8 shrink-0 items-center gap-2 rounded-card border px-3 text-sm font-medium transition-colors",
                              prepBusyId !== null
                                ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                                : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
                            )}
                          >
                            {busy ? (
                              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                            ) : null}
                            {busy
                              ? prepProgress
                                ? `Preparing page ${prepProgress.done} of ${prepProgress.total}…`
                                : "Preparing…"
                              : "Prepare pages"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
            </section>
          ) : null}
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
  extractBusyKey,
  onExtractLegend,
  onExtractSchedule,
  onDetectDevices,
  onExtractRooms,
  onFindRefs,
}: {
  jobId: string;
  plan: PanelPlan;
  sheets: Record<string, EffectiveSheet>;
  running: RunState | null;
  reviewThreshold: number;
  onRun: () => void;
  onSheet: (sheet: EffectiveSheet | null) => void;
  anyRunning: boolean;
  extractBusyKey: string | null;
  onExtractLegend: (pageIndex: number) => void;
  onExtractSchedule: (pageIndex: number, kind: ScheduleTableKind) => void;
  onDetectDevices: (pageIndex: number) => void;
  onExtractRooms: (pageIndex: number) => void;
  onFindRefs: () => void;
}) {
  const planRunning = running?.planId === plan.id;
  const analysed = plan.pages.filter(
    (p) => sheets[sheetKey(plan.id, p.pageIndex)],
  ).length;
  return (
    <section
      aria-label={`Plan analysis for ${planLabel(plan)}`}
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
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={onFindRefs}
            disabled={anyRunning || analysed === 0}
            title={analysed === 0 ? "Analyse pages first" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-card border px-3 text-sm font-medium transition-colors",
              anyRunning || analysed === 0
                ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                : "border-border bg-surface text-text hover:bg-surface-subtle",
            )}
          >
            <ScanSearch aria-hidden="true" className="h-4 w-4" />
            Find references
          </button>
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
            {planRunning ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <ScanSearch aria-hidden="true" className="h-4 w-4" />
            )}
            {planRunning
              ? `Analysing ${running!.done}/${running!.total}…`
              : analysed === plan.pages.length && analysed > 0
                ? "Re-check pages"
                : "Analyse pages"}
          </button>
        </span>
      </div>
      {planRunning ? (
        // A working AI run looks IDLE without this — each page takes the model
        // a while, so show live progress (real done/total, never a fake %) the
        // whole time instead of only a quiet button label.
        <div className="border-b border-border px-4 py-2.5" role="status" data-testid="analysis-progress">
          <Bar
            pct={running!.total > 0 ? (running!.done / running!.total) * 100 : 0}
            tone="warning"
            aria-label="Analysis progress"
          />
          <p className="mt-1.5 inline-flex items-center gap-2 text-xs text-text-muted">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Analysing page {Math.min(running!.done + 1, running!.total)} of {running!.total} — the
            AI reads each page; this can take a minute per page. Leave this tab open.
          </p>
        </div>
      ) : null}
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
                extractBusy={extractBusyKey === sheetKey(plan.id, page.pageIndex)}
                onExtractLegend={
                  sheet?.fields.sheetType.effective === "legend" && !anyRunning
                    ? () => onExtractLegend(page.pageIndex)
                    : undefined
                }
                onExtractSchedule={
                  sheet?.fields.sheetType.effective === "schedule" && !anyRunning
                    ? (kind) => onExtractSchedule(page.pageIndex, kind)
                    : undefined
                }
                onDetectDevices={
                  sheet?.fields.sheetType.effective === "floorPlan" && !anyRunning
                    ? () => onDetectDevices(page.pageIndex)
                    : undefined
                }
                onExtractRooms={
                  sheet?.fields.sheetType.effective === "floorPlan" && !anyRunning
                    ? () => onExtractRooms(page.pageIndex)
                    : undefined
                }
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
  extractBusy = false,
  onExtractLegend,
  onExtractSchedule,
  onDetectDevices,
  onExtractRooms,
}: {
  jobId: string;
  planId: string;
  pageIndex: number;
  pngUrl: string;
  sheet: EffectiveSheet | undefined;
  reviewThreshold: number;
  onSheet: (sheet: EffectiveSheet | null) => void;
  extractBusy?: boolean;
  onExtractLegend?: () => void;
  onExtractSchedule?: (kind: ScheduleTableKind) => void;
  onDetectDevices?: () => void;
  onExtractRooms?: () => void;
}) {
  // While an extraction runs every callback is withdrawn (anyRunning), so the
  // busy row keeps showing only the button group its sheet type owns.
  const effectiveType = sheet?.fields.sheetType.effective;
  const showLegend = Boolean(onExtractLegend) || (extractBusy && effectiveType === "legend");
  const showSchedule =
    Boolean(onExtractSchedule) || (extractBusy && effectiveType === "schedule");
  const showDetect = Boolean(onDetectDevices) || (extractBusy && effectiveType === "floorPlan");
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
        {showLegend ? (
          <button
            type="button"
            onClick={onExtractLegend}
            disabled={!onExtractLegend || extractBusy}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-card border px-2.5 text-xs font-medium",
              extractBusy || !onExtractLegend
                ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                : "border-border bg-surface text-text hover:bg-surface-subtle",
            )}
          >
            {extractBusy ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {extractBusy ? "Extracting legend…" : "Extract legend"}
          </button>
        ) : null}
        {showSchedule ? (
          <>
            <button
              type="button"
              onClick={() => onExtractSchedule?.("lighting")}
              disabled={!onExtractSchedule || extractBusy}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-card border px-2.5 text-xs font-medium",
                extractBusy || !onExtractSchedule
                  ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                  : "border-border bg-surface text-text hover:bg-surface-subtle",
              )}
            >
              {extractBusy ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {extractBusy ? "Extracting…" : "Extract lighting schedule"}
            </button>
            <button
              type="button"
              onClick={() => onExtractSchedule?.("switchboard")}
              disabled={!onExtractSchedule || extractBusy}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-card border px-2.5 text-xs font-medium",
                extractBusy || !onExtractSchedule
                  ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                  : "border-border bg-surface text-text hover:bg-surface-subtle",
              )}
            >
              {extractBusy ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {extractBusy ? "Extracting…" : "Extract board schedule"}
            </button>
          </>
        ) : null}
        {showDetect ? (
          <>
            <button
              type="button"
              onClick={onDetectDevices}
              disabled={!onDetectDevices || extractBusy}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-card border px-2.5 text-xs font-medium",
                extractBusy || !onDetectDevices
                  ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                  : "border-border bg-surface text-text hover:bg-surface-subtle",
              )}
            >
              {extractBusy ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {extractBusy ? "Working…" : "Detect devices"}
            </button>
            <button
              type="button"
              onClick={onExtractRooms}
              disabled={!onExtractRooms || extractBusy}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-card border px-2.5 text-xs font-medium",
                extractBusy || !onExtractRooms
                  ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                  : "border-border bg-surface text-text hover:bg-surface-subtle",
              )}
            >
              {extractBusy ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {extractBusy ? "Mapping rooms…" : "Map rooms"}
            </button>
          </>
        ) : null}
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
