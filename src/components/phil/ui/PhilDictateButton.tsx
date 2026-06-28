"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import {
  appendDictation,
  detectDictationMode,
  getDictationController,
  type DictationErrorKind,
  type DictationMode,
} from "../speechDictation";
import { PhilNotice } from "./PhilNotice";
import { cn } from "@/lib/cn";

interface Props {
  /** The field's current value — recognised text is appended to it. */
  value: string;
  /** The field's setter — same one the textarea's onChange uses. Dictation
   *  APPENDS via this, so typed text is never clobbered. */
  onAppend: (next: string) => void;
  /** The field's character cap (its `maxLength`) — dictation can't push the
   *  note past the server-validated limit. */
  max: number;
  /** Focus the associated field (used on the iOS keyboard-nudge path so the
   *  worker can tap the keyboard's own mic key). */
  onFocusField?: () => void;
  /** False when the device is offline — dictation needs the vendor speech
   *  service, so the control disables and says so honestly. */
  online?: boolean;
  /** Disable while the surrounding sheet is busy (uploading/submitting). */
  disabled?: boolean;
  className?: string;
}

/** UI state of the live mic, separate from the device capability `mode`. */
export type DictateLiveState =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "denied" }
  | { kind: "stopped"; message: string };

/**
 * Phil's speak-a-note control (#147).
 *
 * A mic button beside the capture/observation note textareas. Tap → talk →
 * the recognised text is APPENDED to whatever's already typed; the worker
 * reviews and edits before sending (nothing auto-sends). Sized ≥48px (h-12) for
 * gloves and styled with the `state-*` rail/icon treatment (no opacity tints)
 * so the "listening" state survives a midday-sun glance.
 *
 * Honesty (P7): the helper copy says recognition uses the PHONE's built-in
 * speech service (the same trust surface as the keyboard's mic key) and that
 * BuhlOS servers receive **text only** — it does NOT claim "no audio leaves the
 * device" (Web Speech streams audio to the browser vendor).
 *
 * Device behaviour (see speechDictation.detectDictationMode):
 *   - unsupported       → renders NOTHING (honest fallback, typed input intact).
 *   - keyboard-nudge    → iOS standalone PWA → focuses the field + a one-line
 *                         hint pointing at the keyboard mic key.
 *   - api               → the in-app mic button.
 *
 * Permission denial shows a ONE-TIME hint, then the control hides for the rest
 * of the session — it never re-prompts on every open.
 *
 * The rendering lives in the pure {@link DictateButtonView} (props only, no
 * effects) so the visual states are SSR-testable; this container owns the
 * device detection, the recognition lifecycle and the live state.
 */
export function PhilDictateButton({
  value,
  onAppend,
  max,
  onFocusField,
  online = true,
  disabled = false,
  className,
}: Props) {
  // Mode is device capability — resolved once on mount (effects don't run under
  // SSR, so the first paint is "unsupported" → nothing, which is the safe
  // default and avoids a hydration flash of a control that may not work).
  const [mode, setMode] = useState<DictationMode>("unsupported");
  const [state, setState] = useState<DictateLiveState>({ kind: "idle" });

  // Latest value/max for the result handler without re-subscribing the engine.
  const valueRef = useRef(value);
  valueRef.current = value;
  const maxRef = useRef(max);
  maxRef.current = max;

  useEffect(() => {
    setMode(detectDictationMode());
  }, []);

  const stop = useCallback(() => {
    getDictationController().stop();
  }, []);

  // Stop any live session if the control unmounts (sheet close / submit).
  // The typed note is unaffected.
  useEffect(() => {
    return () => {
      getDictationController().stop();
    };
  }, []);

  // If the surrounding sheet goes busy mid-listen, stop honestly.
  useEffect(() => {
    if (disabled && state.kind === "listening") getDictationController().stop();
  }, [disabled, state.kind]);

  const start = useCallback(() => {
    const ok = getDictationController().start({
      onResult: (text) => {
        if (text) onAppend(appendDictation(valueRef.current, text, maxRef.current));
      },
      onError: (kind: DictationErrorKind) => {
        if (kind === "permission") {
          setState({ kind: "denied" });
          return;
        }
        if (kind === "no-speech") {
          setState({ kind: "stopped", message: "Didn't catch that — tap to try again." });
          return;
        }
        if (kind === "network") {
          setState({
            kind: "stopped",
            message: "Lost signal — dictation stopped. Your typed note is safe.",
          });
          return;
        }
        setState({ kind: "stopped", message: "Dictation stopped. Tap to try again." });
      },
      onEnd: () => {
        setState((prev) => (prev.kind === "listening" ? { kind: "idle" } : prev));
      },
    });
    if (ok) setState({ kind: "listening" });
  }, [onAppend]);

  const onToggle = useCallback(() => {
    if (state.kind === "listening") stop();
    else start();
  }, [state.kind, start, stop]);

  return (
    <DictateButtonView
      mode={mode}
      state={state}
      online={online}
      disabled={disabled}
      className={className}
      onToggle={onToggle}
      onNudge={() => onFocusField?.()}
    />
  );
}

interface ViewProps {
  mode: DictationMode;
  state: DictateLiveState;
  online: boolean;
  disabled: boolean;
  className?: string;
  /** Toggle listening (api mode). */
  onToggle: () => void;
  /** Focus the field for the keyboard-nudge path. */
  onNudge: () => void;
}

const HONEST_HINT =
  "Uses your phone's built-in speech, like the keyboard mic. BuhlOS only gets the text — review it before you send.";

/**
 * Pure presentational mic control. Driven entirely by `mode` + `state` props,
 * so every visual branch (unsupported / denied / keyboard-nudge / offline /
 * idle / listening / stopped) is reachable under SSR for the render tests.
 */
export function DictateButtonView({
  mode,
  state,
  online,
  disabled,
  className,
  onToggle,
  onNudge,
}: ViewProps) {
  // unsupported → render nothing at all (honest fallback).
  if (mode === "unsupported") return null;

  // Permission denied: one-time hint, then the control hides for the rest of
  // the session (the container never re-enters this state on its own).
  if (state.kind === "denied") {
    return (
      <PhilNotice tone="neutral" role="status" className={className}>
        Mic is blocked for this site. To dictate, allow the microphone in your
        browser settings — typing still works.
      </PhilNotice>
    );
  }

  // iOS standalone PWA: no in-app mic, point at the keyboard's own mic key.
  if (mode === "keyboard-nudge") {
    return (
      <div className={cn("space-y-2", className)}>
        <button
          type="button"
          disabled={disabled}
          onClick={onNudge}
          aria-label="Dictate this note"
          className={cn(
            "inline-flex h-12 items-center justify-center gap-2 rounded-card px-4",
            "border border-border bg-surface text-sm font-semibold text-text",
            "transition-colors hover:bg-surface-subtle",
            "focus-visible:outline-brand-navy",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <Mic aria-hidden="true" className="h-5 w-5 text-brand-navy" />
          Dictate
        </button>
        <p className="text-xs leading-snug text-text-muted">
          Tap the microphone key on your keyboard to speak this note. It uses
          your phone&rsquo;s built-in speech — BuhlOS only ever gets the text.
        </p>
      </div>
    );
  }

  // api mode — offline guard first (dictation needs the vendor speech service).
  if (!online) {
    return (
      <div className={cn("space-y-2", className)}>
        <button
          type="button"
          disabled
          aria-label="Dictate this note"
          className={cn(
            "inline-flex h-12 items-center justify-center gap-2 rounded-card px-4",
            "border border-border bg-surface text-sm font-semibold text-text",
            "cursor-not-allowed opacity-60",
          )}
        >
          <Mic aria-hidden="true" className="h-5 w-5 text-text-muted" />
          Dictate
        </button>
        <p className="text-xs leading-snug text-text-muted">
          Dictation needs a connection — type your note for now.
        </p>
      </div>
    );
  }

  const listening = state.kind === "listening";

  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={listening}
        aria-busy={listening}
        aria-label={listening ? "Listening — tap to stop" : "Dictate this note"}
        onClick={onToggle}
        className={cn(
          "inline-flex h-12 items-center justify-center gap-2 rounded-card px-4 text-sm font-semibold",
          "border transition-colors",
          "focus-visible:outline-brand-navy",
          "disabled:cursor-not-allowed disabled:opacity-60",
          // Listening uses the state-* rail+icon treatment (solid colour, no
          // opacity tint) so it reads in glare.
          listening
            ? "border-l-4 border-state-danger border-l-state-danger bg-surface text-text"
            : "border-border bg-surface text-text hover:bg-surface-subtle",
        )}
      >
        {listening ? (
          <>
            <Square aria-hidden="true" className="h-4 w-4 fill-state-danger text-state-danger" />
            <span>Listening… tap to stop</span>
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-state-danger" />
          </>
        ) : (
          <>
            <Mic aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            <span>Dictate</span>
          </>
        )}
      </button>

      {state.kind === "stopped" ? (
        <p className="text-xs leading-snug text-state-warning" role="status">
          {state.message}
        </p>
      ) : (
        <p className="text-xs leading-snug text-text-muted">{HONEST_HINT}</p>
      )}
    </div>
  );
}
