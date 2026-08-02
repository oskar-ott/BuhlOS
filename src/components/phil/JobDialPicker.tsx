"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import styles from "./jobDial.module.css";

/** Row height in px — keep in sync with .item / .spacer / .band in jobDial.module.css. */
const ITEM_H = 48;
/** How far a row can tilt on the drum before it holds its edge angle. */
const MAX_TILT_DEG = 62;

/**
 * The spinning job dial (owner-directed 2026-08-02): a scroll-snap wheel that
 * shows any number of assigned jobs inside a fixed 5-row window, so a long
 * job list no longer grows the page (P10 — the picker's slot has constant
 * height now). Flick to spin, tap a job to choose it.
 *
 * Semantics are unchanged from the old vertical list: a radiogroup of radio
 * buttons named by job, tap-to-select — the field-readiness smoke drives it
 * the same way. The barrel curvature is paint-only (scroll-driven transforms
 * on the rows); SSR renders the flat list and the drum forms on hydration.
 */
export function JobDialPicker({
  jobs,
  selectedJobId,
  onSelect,
  disabled,
}: {
  jobs: ReadonlyArray<{ id: string; name: string }>;
  selectedJobId: string | null;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rafRef = useRef<number>(0);
  // The row currently sitting in the selection band (visual emphasis only —
  // selection itself stays tap-driven, aria-checked tracks selectedJobId).
  const [centeredIndex, setCenteredIndex] = useState(0);

  /** Paint the drum: tilt/fade each row by its distance from the band. */
  const paint = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    rowRefs.current.forEach((row, i) => {
      if (!row) return;
      // Rows snap so that row i is centred at scrollTop = i * ITEM_H.
      const d = (i * ITEM_H - scrollTop) / ITEM_H;
      const abs = Math.abs(d);
      const tilt = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, d * 20));
      row.style.transform = `perspective(700px) rotateX(${-tilt}deg) scale(${Math.max(0.82, 1 - abs * 0.055)})`;
      row.style.opacity = String(Math.max(0.18, 1 - abs * 0.3));
    });
    setCenteredIndex(Math.max(0, Math.min(jobs.length - 1, Math.round(scrollTop / ITEM_H))));
  }, [jobs.length]);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Land on the chosen job (or the top) whenever the list changes — e.g. the
  // search narrows it — and paint the initial drum state.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    rowRefs.current = rowRefs.current.slice(0, jobs.length);
    const idx = Math.max(
      0,
      jobs.findIndex((j) => j.id === selectedJobId)
    );
    viewport.scrollTop = idx * ITEM_H;
    paint();
    return () => cancelAnimationFrame(rafRef.current);
    // Deliberately NOT re-running on selectedJobId: selecting closes the
    // picker in the parent; re-centering mid-interaction would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, paint]);

  return (
    <div className={styles.wrap} data-testid="job-dial">
      <div
        ref={viewportRef}
        onScroll={onScroll}
        className={styles.viewport}
        role="radiogroup"
        aria-label="Choose the job for these hours"
      >
        <div className={styles.spacer} aria-hidden="true" />
        {jobs.map((j, i) => {
          const active = j.id === selectedJobId;
          return (
            <button
              key={j.id}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onSelect(j.id)}
              className={cn(styles.item, i === centeredIndex && styles.itemCentered)}
            >
              <span className={styles.itemName}>{j.name}</span>
              {active ? (
                <span aria-hidden="true" className={styles.itemTick}>
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
        <div className={styles.spacer} aria-hidden="true" />
      </div>
      <div className={styles.band} aria-hidden="true" />
      {jobs.length > 1 ? (
        <p className={styles.count} aria-hidden="true">
          {centeredIndex + 1} of {jobs.length} jobs — spin to browse, tap to pick
        </p>
      ) : null}
    </div>
  );
}
