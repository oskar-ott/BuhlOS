"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Eye, EyeOff } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import type { DeviceDetection } from "@/domains/ai-drawings/schema";
import { cropRegionFromPng, padRegion } from "@/domains/ai-drawings/crop";

/**
 * Epic 5 (#204) — raw device detections, clearly unverified.
 *
 * Detection output is a marked-up DRAFT: located instances of THIS project's
 * reviewed legend vocabulary, each inspectable back to its exact spot on the
 * sheet (the provenance round-trip AC). Nothing here is a count — the #205
 * overlay review (delete/add/reclassify → accept) is the only path into
 * takeoffs, and every surface says so. Dense areas the model refused to
 * guess arrive as flagged uncertain regions (P7).
 */

interface DetectionLookup {
  pngUrlFor: (planId: string, pageIndex: number) => string | null;
  labelFor: (planId: string) => string;
}

export function DeviceDetectionCard({
  detections,
  lookup,
}: {
  detections: DeviceDetection[];
  lookup: DetectionLookup;
}) {
  const pages = useMemo(() => {
    const byPage = new Map<string, DeviceDetection[]>();
    for (const d of detections) {
      const key = `${d.planId}:${d.pageIndex}`;
      const list = byPage.get(key) ?? [];
      list.push(d);
      byPage.set(key, list);
    }
    return [...byPage.entries()]
      .map(([key, list]) => ({ key, list }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [detections]);

  return (
    <section
      aria-label="Device detections (unverified)"
      className="rounded-card border border-border bg-surface"
      data-testid="device-detections"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Device detections</CardTitle>
        <CardDescription className="mt-1">
          Raw AI detections against this project&rsquo;s reviewed legend —
          located, inspectable, and <strong>unverified</strong>. Nothing
          becomes a count until it passes the marker review; dense areas the
          AI refused to guess are flagged below.
        </CardDescription>
      </div>
      <div className="divide-y divide-border">
        {pages.map(({ key, list }) => (
          <PageDetections key={key} list={list} lookup={lookup} />
        ))}
      </div>
    </section>
  );
}

function PageDetections({
  list,
  lookup,
}: {
  list: DeviceDetection[];
  lookup: DetectionLookup;
}) {
  const first = list[0]!;
  const devices = list.filter((d) => d.kind === "device");
  const uncertain = list.filter((d) => d.kind === "uncertain-region");
  const byLabel = useMemo(() => {
    const m = new Map<string, DeviceDetection[]>();
    for (const d of devices) {
      const label = d.label ?? "(unlabelled)";
      const arr = m.get(label) ?? [];
      arr.push(d);
      m.set(label, arr);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [devices]);

  return (
    <div className="px-4 py-3" data-testid="detection-page">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">
          {lookup.labelFor(first.planId)} · p{first.pageIndex + 1}
        </span>
        <Pill tone="warning">unverified</Pill>
        <span className="text-xs text-text-muted">
          {devices.length} detection{devices.length === 1 ? "" : "s"} across{" "}
          {byLabel.length} type{byLabel.length === 1 ? "" : "s"}
        </span>
        {uncertain.length > 0 ? (
          <Pill tone="neutral">
            {uncertain.length} uncertain area{uncertain.length === 1 ? "" : "s"}
          </Pill>
        ) : null}
      </div>
      <ul className="mt-2 space-y-1.5">
        {byLabel.map(([label, rows]) => (
          <LabelGroup key={label} label={label} rows={rows} lookup={lookup} />
        ))}
        {uncertain.map((u) => (
          <li key={u.id} className="text-xs text-text-muted" data-testid="uncertain-region">
            Uncertain area{u.note ? ` — ${u.note}` : ""} (needs a human count)
          </li>
        ))}
      </ul>
    </div>
  );
}

const MAX_STRIP_CHARS = 1_500_000;

function LabelGroup({
  label,
  rows,
  lookup,
}: {
  label: string;
  rows: DeviceDetection[];
  lookup: DetectionLookup;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-card border border-border px-3 py-1.5" data-testid="detection-label">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 text-text-muted transition-transform", open ? "rotate-90" : "")}
        />
        <span className="text-sm font-medium text-text">{label}</span>
        <Pill tone="neutral">{rows.length} found (raw)</Pill>
      </button>
      {open ? (
        <ul className="mt-1.5 space-y-1.5 border-l border-border pl-3">
          {rows.map((d, i) => (
            <DetectionRow key={d.id} index={i} detection={d} lookup={lookup} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DetectionRow({
  index,
  detection,
  lookup,
}: {
  index: number;
  detection: DeviceDetection;
  lookup: DetectionLookup;
}) {
  const [strip, setStrip] = useState<null | "loading" | "failed" | string>(null);
  const pngUrl = lookup.pngUrlFor(detection.planId, detection.pageIndex);

  const toggle = async () => {
    if (strip !== null) {
      setStrip(null);
      return;
    }
    if (!pngUrl) return;
    setStrip("loading");
    const dataUrl = await cropRegionFromPng(
      pngUrl,
      padRegion(detection.bbox, 2), // generous context around a tiny symbol
      MAX_STRIP_CHARS,
      16,
    );
    setStrip(dataUrl ?? "failed");
  };

  return (
    <li className="text-xs text-text-muted" data-testid="detection-row">
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>
          #{index + 1} · confidence{" "}
          {detection.confidence !== null ? `${Math.round(detection.confidence * 100)}%` : "?"}
        </span>
        {pngUrl ? (
          <button
            type="button"
            onClick={() => void toggle()}
            aria-label={`${strip !== null ? "Hide" : "Show"} detection ${index + 1} of ${detection.label ?? "device"} on the sheet`}
            aria-expanded={strip !== null}
            className="inline-flex h-5 w-5 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
          >
            {strip !== null ? (
              <EyeOff aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Eye aria-hidden="true" className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </span>
      {strip === "loading" ? (
        <p className="mt-1" role="status">
          Cropping…
        </p>
      ) : null}
      {strip === "failed" ? (
        <p className="mt-1">
          Couldn&rsquo;t crop in this browser —{" "}
          <a
            href={pngUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2"
          >
            open the full page
          </a>
          .
        </p>
      ) : null}
      {strip !== null && strip !== "loading" && strip !== "failed" ? (
        // eslint-disable-next-line @next/next/no-img-element -- transient canvas-cropped data URL
        <img
          src={strip}
          alt={`Location of ${detection.label ?? "device"} detection ${index + 1} on the sheet`}
          className="mt-1 max-h-28 w-auto max-w-full rounded-card border border-border"
        />
      ) : null}
    </li>
  );
}
