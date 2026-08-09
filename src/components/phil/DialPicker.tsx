"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import styles from "./jobDial.module.css";

/** Row height in px — keep in sync with .item / .spacer / .band in jobDial.module.css. */
const ITEM_H = 48;
/** How far a row can tilt on the drum before it holds its edge angle. */
const MAX_TILT_DEG = 62;

/**
 * The generic spinning dial (extracted from JobDialPicker, owner-directed
 * 2026-08-09, so the day picker can share the SAME drum instead of a second
 * implementation): a scroll-snap wheel that shows any number of options
 * inside a fixed 5-row window (P10 — the picker's slot has constant height).
 * Flick to spin, tap a row to choose it.
 *
 * Semantics: a radiogroup of radio buttons, tap-to-select — the
 * field-readiness smoke drives it the same way. The barrel curvature is
 * paint-only (scroll-driven transforms on the rows); SSR renders the flat
 * list and the drum forms on hydration.
 */
export function DialPicker({
  items,
  selectedId,
  onSelect,
  disabled,
  ariaLabel,
  countNoun,
  testId,
}: {
  items: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled: boolean;
  /** The radiogroup's accessible name, e.g. "Choose the job for these hours". */
  ariaLabel: string;
  /** Plural noun for the "N of M <noun>" hint under the drum, e.g. "jobs". */
  countNoun: string;
  testId: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rafRef = useRef<number>(0);
  // The row currently sitting in the selection band (visual emphasis only —
  // selection itself stays tap-driven, aria-checked tracks selectedId).
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
    setCenteredIndex(Math.max(0, Math.min(items.length - 1, Math.round(scrollTop / ITEM_H))));
  }, [items.length]);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Land on the chosen row (or the top) whenever the list changes — e.g. a
  // search narrows it — and paint the initial drum state.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    rowRefs.current = rowRefs.current.slice(0, items.length);
    const idx = Math.max(
      0,
      items.findIndex((it) => it.id === selectedId)
    );
    viewport.scrollTop = idx * ITEM_H;
    paint();
    return () => cancelAnimationFrame(rafRef.current);
    // Deliberately NOT re-running on selectedId: selecting may close the
    // picker in the parent; re-centering mid-interaction would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, paint]);

  return (
    <div className={styles.wrap} data-testid={testId}>
      <div
        ref={viewportRef}
        onScroll={onScroll}
        className={styles.viewport}
        role="radiogroup"
        aria-label={ariaLabel}
      >
        <div className={styles.spacer} aria-hidden="true" />
        {items.map((it, i) => {
          const active = it.id === selectedId;
          return (
            <button
              key={it.id}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onSelect(it.id)}
              className={cn(styles.item, i === centeredIndex && styles.itemCentered)}
            >
              <span className={styles.itemName}>{it.label}</span>
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
      {items.length > 1 ? (
        <p className={styles.count} aria-hidden="true">
          {centeredIndex + 1} of {items.length} {countNoun} — spin to browse, tap to pick
        </p>
      ) : null}
    </div>
  );
}
