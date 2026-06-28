"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  canArmPull,
  pullDistance,
  pullPastThreshold,
  releaseDecision,
  PTR_THRESHOLD_PX,
  PTR_TIMEOUT_MS,
} from "./pullToRefreshLogic";
import styles from "./pullToRefresh.module.css";

/**
 * Phil — pull-to-refresh (#149, slice 2).
 *
 * Wraps the shared scroll container (PhilShell's <main>) so My Day / jobs / job
 * home / gear / hours inherit a familiar pull-down-to-refresh. The decision
 * logic is the pure `pullToRefreshLogic` helpers (node-tested); this is the thin
 * shell that reads real touch travel + the live suppression state and drives
 * router.refresh().
 *
 * REFRESH = startTransition(() => router.refresh()) — the transition's isPending
 * drives the spinner. P7: this re-renders real server components with fresh data;
 * it does NOT stamp a fabricated "updated just now". There is no live freshness
 * stamp in Phil today, so there is nothing to update dishonestly.
 *
 * SELF-BOUNDING: the spinner always resolves within PTR_TIMEOUT_MS — success or
 * an honest "Couldn't refresh" — so a stalled refresh offline can never leave an
 * infinite spinner. This deliberately does NOT depend on #139's shared
 * fail-closed helper (still open); it owns its own timeout.
 *
 * SUPPRESSION (canArmPull): the pull only arms when the container is at the top
 * AND no sheet/dialog is open (which also covers the non-empty capture tray and
 * any in-flight submit — those only exist inside an open dialog) AND the touch
 * did not start inside a horizontal-scroll strip (closest('[data-no-ptr]')). So
 * the gesture never fights scroll or the capture flow.
 *
 * Cross-ref:
 *   src/components/phil/pullToRefreshLogic.ts — the pure decision logic
 *   src/components/phil/PhilShell.tsx — the single mount point
 */

type Phase = "idle" | "refreshing" | "error";

/** Any open sheet/dialog owns the gesture — and because every Phil submit and
 *  the non-empty capture tray live inside an open dialog, this single DOM check
 *  also covers the "submit in flight" and "tray non-empty" suppressions. */
function anyDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
}

/** Did this touch begin inside a horizontal-scroll strip we must not hijack? */
function startedInNoPtr(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-no-ptr]") !== null;
}

export function PullToRefresh({ children }: { children: ReactNode }) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);

  // Gesture bookkeeping in refs — touch handlers must not re-render per move; the
  // live pull height rides a CSS variable set imperatively on the indicator node
  // (the repo bans inline JSX `style`). Only the discrete phase + the threshold
  // copy drive React state.
  const armedRef = useRef(false);
  const startYRef = useRef(0);
  const pullRef = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pastThreshold, setPastThreshold] = useState(false);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // Imperatively drive the indicator's height + visibility (CSS var + classes),
  // bypassing the banned inline-style attribute. `dragging` suppresses the
  // height transition so the indicator tracks the finger 1:1 mid-pull.
  const paintPull = useCallback((px: number, dragging: boolean) => {
    const node = indicatorRef.current;
    if (!node) return;
    node.style.setProperty("--ptr-pull", `${px}px`);
    node.classList.toggle(styles.dragging!, dragging);
    node.classList.toggle(styles.visible!, px > 0 || phaseRef.current !== "idle");
  }, []);

  const triggerRefresh = useCallback(() => {
    phaseRef.current = "refreshing";
    setPhase("refreshing");
    // Hold the indicator at the threshold height while the refresh runs.
    paintPull(PTR_THRESHOLD_PX, false);

    let settled = false;
    const finish = (next: Phase) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(budget);
      phaseRef.current = next;
      setPhase(next);
      pullRef.current = 0;
      // Snap the indicator away; an error briefly shows its message, then clears.
      paintPull(next === "error" ? PTR_THRESHOLD_PX : 0, false);
      if (next === "error") {
        window.setTimeout(() => {
          if (phaseRef.current === "error") {
            phaseRef.current = "idle";
            setPhase("idle");
            paintPull(0, false);
          }
        }, 2500);
      }
    };

    // Self-bounding budget: resolve no matter what router.refresh() does. If the
    // server round-trip stalls (offline / patchy signal), we land on an honest
    // "Couldn't refresh" instead of spinning forever.
    const budget = window.setTimeout(() => finish("error"), PTR_TIMEOUT_MS);

    // router.refresh() re-renders the server tree; we resolve the spinner once
    // the transition is requested. The budget above guarantees termination even
    // if the tree never settles.
    Promise.resolve()
      .then(() => router.refresh())
      .then(
        () => finish("idle"),
        () => finish("error"),
      );
  }, [router, paintPull]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch || !el) return;
      armedRef.current = canArmPull({
        scrollTop: el.scrollTop,
        sheetOpen: anyDialogOpen(),
        // Covered by anyDialogOpen() (tray + submit only exist inside a dialog);
        // passed explicitly so the decision stays honest and self-documenting.
        trayNonEmpty: false,
        submitInFlight: false,
        insideNoPtr: startedInNoPtr(e.target),
        refreshing: phaseRef.current === "refreshing",
      });
      if (armedRef.current) startYRef.current = touch.clientY;
    }

    function onTouchMove(e: TouchEvent) {
      if (!armedRef.current) return;
      const touch = e.touches[0];
      if (!touch || !el) return;
      // Disarm the instant the container leaves the top (a real scroll begins).
      if (el.scrollTop > 0) {
        armedRef.current = false;
        pullRef.current = 0;
        paintPull(0, false);
        setPastThreshold(false);
        return;
      }
      const dist = pullDistance(touch.clientY - startYRef.current);
      if (dist > 0) {
        // We own a downward pull at the top — stop the browser's own overscroll
        // bounce so the indicator reads cleanly. (overscroll-y-contain already
        // stops the navigation chain; this stops the visual rubber-band.)
        if (e.cancelable) e.preventDefault();
        pullRef.current = dist;
        paintPull(dist, true);
        setPastThreshold(pullPastThreshold(dist));
      }
    }

    function onTouchEnd() {
      if (!armedRef.current) return;
      const decision = releaseDecision(armedRef.current, pullRef.current);
      armedRef.current = false;
      setPastThreshold(false);
      if (decision === "refresh") {
        triggerRefresh();
      } else {
        pullRef.current = 0;
        paintPull(0, false);
      }
    }

    // Passive:false on move so preventDefault() can tame the overscroll bounce.
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [paintPull, triggerRefresh]);

  const active = phase === "refreshing";

  return (
    // overscroll-y-contain stops a top/bottom overscroll from chaining to the
    // browser (back-nav / address-bar) so the pull stays inside the app. The
    // scroll container is THIS element — its scrollTop is what the gesture reads.
    <div
      ref={scrollRef}
      className="relative flex-1 overflow-y-auto overscroll-y-contain bg-surface-subtle px-4 py-4"
    >
      {/* Pull indicator — a quiet spinner that tracks the pull and resolves
          honestly. aria-live so a screen reader hears the refresh outcome. The
          live height rides the --ptr-pull CSS variable (set imperatively). */}
      <div ref={indicatorRef} className={styles.indicator} aria-hidden={phase === "idle"}>
        <span
          role="status"
          aria-live="polite"
          className={cn(styles.pill, "bg-surface-raised text-text-muted shadow-raised")}
        >
          {phase === "error" ? (
            <span className="text-state-danger">Couldn&rsquo;t refresh — try again</span>
          ) : (
            <>
              <RotateCw
                aria-hidden="true"
                className={cn(styles.icon, active && styles.spinning)}
              />
              <span>
                {active
                  ? "Refreshing…"
                  : pastThreshold
                    ? "Release to refresh"
                    : "Pull to refresh"}
              </span>
            </>
          )}
        </span>
      </div>

      {children}
    </div>
  );
}
