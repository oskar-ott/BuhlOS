"use client";

import { useMemo, useState } from "react";
import { Check, Eye, EyeOff, GitCompareArrows, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { DiffRegion, PageDiff } from "@/domains/ai-drawings/schema";
import { reviewDiffRegion } from "@/domains/ai-drawings/client";
import { cropRegionFromPng, padRegion } from "@/domains/ai-drawings/crop";

/**
 * Epic 5 (#203) — revision diff review: walk every changed region between
 * two revisions of a sheet.
 *
 * Honesty is the whole feature: the diff shows WHERE pixels changed — the
 * human judges what it means. Every diff carries its basis (alignment
 * quality, threshold, title-block mask); byte-identical pages say so; pairs
 * that couldn't be aligned were refused upstream and never appear here as
 * an empty "no changes".
 */

export interface RevisionPair {
  headPlanId: string;
  basePlanId: string;
  headLabel: string;
  baseLabel: string;
  pageCount: number;
}

interface DiffLookup {
  pngUrlFor: (planId: string, pageIndex: number) => string | null;
  labelFor: (planId: string) => string;
}

export function RevisionDiffCard({
  jobId,
  diffs,
  regions,
  pairs,
  comparing,
  onComparePair,
  lookup,
  onRegion,
}: {
  jobId: string;
  diffs: PageDiff[];
  regions: DiffRegion[];
  pairs: RevisionPair[];
  comparing: { headPlanId: string; done: number; total: number } | null;
  onComparePair: (pair: RevisionPair) => void;
  lookup: DiffLookup;
  onRegion: (region: DiffRegion) => void;
}) {
  const regionsByDiff = useMemo(() => {
    const m = new Map<string, DiffRegion[]>();
    for (const r of regions) {
      const list = m.get(r.diffId) ?? [];
      list.push(r);
      m.set(r.diffId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.regionIndex - b.regionIndex);
    return m;
  }, [regions]);

  return (
    <section
      aria-label="Revision changes"
      className="rounded-card border border-border bg-surface"
      data-testid="revision-diff"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Revision changes</CardTitle>
        <CardDescription className="mt-1">
          Compares two revisions of a sheet and flags where the pixels
          changed — you judge what each change means and walk every region.
          The title block is masked (its revision table always changes).
        </CardDescription>
        {pairs.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {pairs.map((p) => {
              const busy = comparing?.headPlanId === p.headPlanId;
              return (
                <button
                  key={`${p.headPlanId}:${p.basePlanId}`}
                  type="button"
                  onClick={() => onComparePair(p)}
                  disabled={comparing !== null}
                  className={cn(
                    "inline-flex h-8 items-center gap-2 rounded-card border px-3 text-sm font-medium",
                    comparing !== null
                      ? "cursor-not-allowed border-border bg-surface-subtle text-text-muted"
                      : "border-brand-navy bg-brand-navy text-text-inverse hover:opacity-90",
                  )}
                >
                  <GitCompareArrows aria-hidden="true" className="h-4 w-4" />
                  {busy
                    ? `Comparing ${comparing.done}/${comparing.total}…`
                    : `Compare ${p.headLabel} against ${p.baseLabel} (${p.pageCount} page${p.pageCount === 1 ? "" : "s"})`}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {diffs.length === 0 ? (
        <p className="p-4 text-center text-sm text-text-muted">
          No comparisons yet — run one on a superseded drawing above.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {diffs.map((d) => (
            <DiffSection
              key={d.id}
              jobId={jobId}
              diff={d}
              regions={regionsByDiff.get(d.id) ?? []}
              lookup={lookup}
              onRegion={onRegion}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DiffSection({
  jobId,
  diff,
  regions,
  lookup,
  onRegion,
}: {
  jobId: string;
  diff: PageDiff;
  regions: DiffRegion[];
  lookup: DiffLookup;
  onRegion: (region: DiffRegion) => void;
}) {
  const walked = regions.filter((r) => r.status !== "pending").length;
  const quality =
    diff.alignment !== null ? `${Math.round(diff.alignment.quality * 100)}%` : null;
  const threshold =
    typeof diff.basis.threshold === "number" ? String(diff.basis.threshold) : null;
  return (
    <div className="px-4 py-3" data-testid="diff-section">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">
          {lookup.labelFor(diff.headPlanId)} · p{diff.headPageIndex + 1}
        </span>
        <span className="text-xs text-text-muted">
          vs {lookup.labelFor(diff.basePlanId)} · p{diff.basePageIndex + 1}
        </span>
        {diff.identical ? (
          <Pill tone="success">byte-identical</Pill>
        ) : (
          <>
            <Pill tone={diff.regionCount === 0 ? "success" : "warning"}>
              {diff.regionCount} changed region{diff.regionCount === 1 ? "" : "s"}
            </Pill>
            {diff.regionCount > 0 ? (
              <Pill tone={walked === regions.length ? "success" : "neutral"}>
                {walked}/{regions.length} walked
              </Pill>
            ) : null}
          </>
        )}
      </div>
      {/* the diff's basis — "no changes" never appears without it */}
      <p className="mt-1 text-[11px] text-text-muted" data-testid="diff-basis">
        {diff.identical
          ? "identical rasters (same sha256) — no comparison needed"
          : `alignment ${quality ?? "?"} · pixel threshold ${threshold ?? "?"} · title block masked · ${diff.algoVersion}`}
      </p>
      {regions.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {regions.map((r) => (
            <DiffRegionRow
              key={r.id}
              jobId={jobId}
              diff={diff}
              region={r}
              lookup={lookup}
              onRegion={onRegion}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const MAX_STRIP_CHARS = 2_000_000;

function DiffRegionRow({
  jobId,
  diff,
  region,
  lookup,
  onRegion,
}: {
  jobId: string;
  diff: PageDiff;
  region: DiffRegion;
  lookup: DiffLookup;
  onRegion: (region: DiffRegion) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // null = hidden; "loading"; "failed"; else {head, base} data URLs
  const [strips, setStrips] = useState<null | "loading" | "failed" | { head: string; base: string | null }>(null);

  const act = async (status: "reviewed" | "dismissed") => {
    setBusy(true);
    setError("");
    try {
      const out = await reviewDiffRegion(jobId, region.id, status);
      onRegion(out.region);
    } catch (err) {
      setError(err instanceof Error ? err.message : "review failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleStrips = async () => {
    if (strips !== null) {
      setStrips(null);
      return;
    }
    const headUrl = lookup.pngUrlFor(diff.headPlanId, diff.headPageIndex);
    const baseUrl = lookup.pngUrlFor(diff.basePlanId, diff.basePageIndex);
    if (!headUrl) return;
    setStrips("loading");
    const padded = padRegion(region.bbox, 0.4);
    const head = await cropRegionFromPng(headUrl, padded, MAX_STRIP_CHARS, 16);
    // base strip uses the same coordinates — alignment drift is a few px,
    // fine for eyeballing; the honest source of truth is the full pages.
    const base = baseUrl ? await cropRegionFromPng(baseUrl, padded, MAX_STRIP_CHARS, 16) : null;
    setStrips(head ? { head, base } : "failed");
  };

  return (
    <li className="rounded-card border border-border px-3 py-2" data-testid="diff-region">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">Region {region.regionIndex + 1}</span>
        {region.status === "pending" ? <Pill tone="warning">to walk</Pill> : null}
        {region.status === "reviewed" ? <Pill tone="success">reviewed</Pill> : null}
        {region.status === "dismissed" ? <Pill tone="neutral">dismissed</Pill> : null}
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void toggleStrips()}
            aria-label={`${strips !== null ? "Hide" : "Show"} before/after strips for region ${region.regionIndex + 1}`}
            aria-expanded={strips !== null}
            className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
          >
            {strips !== null ? (
              <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Eye aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
          {region.status !== "reviewed" ? (
            <button
              type="button"
              onClick={() => void act("reviewed")}
              disabled={busy}
              aria-label={`Mark region ${region.regionIndex + 1} reviewed`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text hover:bg-surface-subtle"
            >
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {region.status !== "dismissed" ? (
            <button
              type="button"
              onClick={() => void act("dismissed")}
              disabled={busy}
              aria-label={`Dismiss region ${region.regionIndex + 1}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      {strips === "loading" ? (
        <p className="mt-1.5 text-xs text-text-muted" role="status">
          Cropping before/after strips…
        </p>
      ) : null}
      {strips === "failed" ? (
        <p className="mt-1.5 text-xs text-text-muted">
          Couldn&rsquo;t crop in this browser — open the{" "}
          <a
            href={lookup.pngUrlFor(diff.headPlanId, diff.headPageIndex) ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2"
          >
            full page
          </a>{" "}
          instead.
        </p>
      ) : null}
      {strips !== null && strips !== "loading" && strips !== "failed" ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <figure>
            <figcaption className="text-[11px] uppercase tracking-wider text-text-muted">
              Before ({lookup.labelFor(diff.basePlanId)})
            </figcaption>
            {strips.base ? (
              // eslint-disable-next-line @next/next/no-img-element -- transient canvas-cropped data URL
              <img
                src={strips.base}
                alt={`Region ${region.regionIndex + 1} on the older revision`}
                className="mt-0.5 max-h-40 w-auto max-w-full rounded-card border border-border"
              />
            ) : (
              <p className="mt-0.5 text-xs text-text-muted">not available</p>
            )}
          </figure>
          <figure>
            <figcaption className="text-[11px] uppercase tracking-wider text-text-muted">
              After ({lookup.labelFor(diff.headPlanId)})
            </figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element -- transient canvas-cropped data URL */}
            <img
              src={strips.head}
              alt={`Region ${region.regionIndex + 1} on the newer revision`}
              className="mt-0.5 max-h-40 w-auto max-w-full rounded-card border border-border"
            />
          </figure>
        </div>
      ) : null}
      {error ? (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
