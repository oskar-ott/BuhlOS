/**
 * Speech dictation adapter for Phil note fields (#147).
 *
 * Pure, DOM-light wrapper around the browser's built-in Web Speech API
 * (`SpeechRecognition` / `webkitSpeechRecognition`). It exists so the worker can
 * *speak* a note instead of typing it on site with gloves and dirty hands
 * (Phil constitution P10 — additive: the keyboard still works).
 *
 * HONESTY (P7): recognition runs on the PHONE's built-in speech service — the
 * SAME trust surface as the keyboard's mic key. Web Speech streams audio to the
 * browser/OS vendor, so we must NOT claim "no audio leaves the device". What we
 * *can* say honestly is that **BuhlOS servers receive text only**: this module
 * never records, uploads, or POSTs audio anywhere — the only thing that leaves
 * the worker's hands is the final recognised text, appended to the note they
 * review before sending.
 *
 * Design:
 *   - `detectDictationMode()` decides per-device whether to offer the in-app
 *     mic (`api`), nudge the worker to the keyboard mic key (`keyboard-nudge`,
 *     used on iOS standalone PWAs where Web Speech is unreliable), or hide the
 *     control entirely (`unsupported`).
 *   - `appendDictation()` folds recognised text onto whatever the worker already
 *     typed — it APPENDS, never clobbers — and respects a character cap.
 *   - `getDictationController()` returns a MODULE-LEVEL singleton so only ONE
 *     recognition instance is ever live, even with a mic beside several fields.
 *
 * No React, no JSX — unit-testable in node-env.
 */

export type DictationMode = "api" | "keyboard-nudge" | "unsupported";

/** Minimal shape of the bits of the Web Speech API we use — typed locally so we
 *  don't depend on lib.dom's optional SpeechRecognition typings. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface DictationGlobals {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  navigator?: { userAgent?: string; standalone?: boolean };
  matchMedia?: (query: string) => { matches: boolean };
}

/** Resolve the global object without assuming a browser (node-env tests pass an
 *  explicit fake). */
function resolveGlobals(g?: DictationGlobals): DictationGlobals {
  if (g) return g;
  if (typeof window !== "undefined") return window as unknown as DictationGlobals;
  return {};
}

function getRecognitionCtor(g: DictationGlobals): SpeechRecognitionCtor | null {
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/** True for iOS (iPhone/iPad/iPod) — including iPadOS, which reports as a Mac
 *  but exposes touch. */
function isIos(g: DictationGlobals): boolean {
  const ua = g.navigator?.userAgent ?? "";
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS 13+ masquerades as desktop Safari; the touch heuristic is the
  // documented tell. Kept narrow so desktop Macs aren't mislabelled.
  if (/macintosh/i.test(ua) && typeof (g.navigator as { maxTouchPoints?: number })?.maxTouchPoints === "number") {
    return ((g.navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0) > 1;
  }
  return false;
}

/** True when running as an installed/standalone PWA (no browser chrome). On iOS
 *  this is where Web Speech is unreliable, so we steer to the keyboard mic. */
function isStandalonePwa(g: DictationGlobals): boolean {
  if (g.navigator?.standalone === true) return true;
  try {
    return g.matchMedia?.("(display-mode: standalone)")?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Decide how (or whether) to offer dictation on this device.
 *
 *   - `unsupported`     → no SpeechRecognition at all → render NOTHING.
 *   - `keyboard-nudge`  → iOS standalone PWA → in-app recognition is flaky, so
 *                         point the worker at the keyboard's own mic key.
 *   - `api`             → use the in-app mic button.
 *
 * The iOS-standalone carve-out is the load-bearing honest-fallback decision
 * from #147: rather than ship a mic that silently fails in the field, we hand
 * iOS PWA users to the OS keyboard dictation they already trust.
 */
export function detectDictationMode(g?: DictationGlobals): DictationMode {
  const globals = resolveGlobals(g);
  if (!getRecognitionCtor(globals)) return "unsupported";
  if (isIos(globals) && isStandalonePwa(globals)) return "keyboard-nudge";
  return "api";
}

/**
 * Append recognised text to whatever the worker already typed, capped to `max`.
 *
 * Rules (P10 — never degrade typed input):
 *   - APPENDS — the existing value is never replaced.
 *   - inserts a single space between existing text and the new fragment when
 *     the existing text doesn't already end in whitespace.
 *   - trims the incoming fragment's edges; collapses to a no-op for blank input.
 *   - hard-caps the result at `max` characters (the field's own maxLength), so
 *     dictation can never push the note over the server-validated limit.
 */
export function appendDictation(existing: string, fragment: string, max: number): string {
  const add = fragment.trim();
  if (!add) return existing.slice(0, max);
  const needsSpace = existing.length > 0 && !/\s$/.test(existing);
  const joined = existing + (needsSpace ? " " : "") + add;
  return joined.slice(0, max);
}

/** Outcome reported back to the UI when a recognition session ends. */
export type DictationEndReason = "result" | "error" | "stopped";

export interface DictationCallbacks {
  /** Final recognised text (already trimmed by the engine). Fired once per
   *  session (we run final-only, single-shot). */
  onResult: (text: string) => void;
  /** A recognition error — `permission` for mic/permission denial, `no-speech`
   *  when nothing was heard, `network` for signal loss mid-dictation, `other`
   *  otherwise. The field's typed input is always left untouched. */
  onError: (kind: DictationErrorKind) => void;
  /** Session ended (for any reason) — the UI returns to its idle state. */
  onEnd: () => void;
}

export type DictationErrorKind = "permission" | "no-speech" | "network" | "other";

function classifyError(raw: string): DictationErrorKind {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission";
    case "no-speech":
      return "no-speech";
    case "network":
      return "network";
    default:
      return "other";
  }
}

export interface DictationController {
  /** True while a recognition session is live. */
  isListening: () => boolean;
  /** Begin a single-shot, final-only, en-AU recognition session. Stops any
   *  in-flight session first (one instance, ever). Returns false if speech
   *  recognition isn't available. */
  start: (callbacks: DictationCallbacks) => boolean;
  /** Stop the live session (the engine still flushes a final result if it has
   *  one). Idempotent. */
  stop: () => void;
}

/**
 * Build a controller around a single, reused SpeechRecognition instance.
 *
 * Exported for tests (which pass a fake ctor). Production code uses the
 * module-level singleton via {@link getDictationController}.
 */
export function createDictationController(g?: DictationGlobals): DictationController {
  const globals = resolveGlobals(g);
  let recognition: SpeechRecognitionLike | null = null;
  let listening = false;
  let stopRequested = false;
  let active: DictationCallbacks | null = null;

  function teardown() {
    listening = false;
    stopRequested = false;
    active = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    }
  }

  return {
    isListening: () => listening,
    start(callbacks) {
      const Ctor = getRecognitionCtor(globals);
      if (!Ctor) return false;

      // One instance, ever: if a session is already live (a mic on another
      // field), stop it before starting here.
      if (recognition && listening) {
        try {
          recognition.abort();
        } catch {
          /* ignore — we're replacing it anyway */
        }
        teardown();
      }

      if (!recognition) recognition = new Ctor();
      const rec = recognition;
      rec.lang = "en-AU";
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      active = callbacks;
      listening = true;

      rec.onresult = (event) => {
        if (active !== callbacks) return;
        let text = "";
        const results = event.results;
        for (let i = 0; i < results.length; i += 1) {
          const alt = results[i]?.[0];
          if (alt?.transcript) text += alt.transcript;
        }
        callbacks.onResult(text.trim());
      };
      rec.onerror = (event) => {
        if (active !== callbacks) return;
        callbacks.onError(classifyError(event.error));
      };
      rec.onend = () => {
        if (active !== callbacks) return;
        teardown();
        callbacks.onEnd();
      };

      try {
        rec.start();
      } catch {
        // Calling start() twice throws (InvalidStateError) — treat as a no-op
        // failure and report a clean stop so the UI resets.
        teardown();
        callbacks.onError("other");
        callbacks.onEnd();
        return false;
      }
      return true;
    },
    stop() {
      // Idempotent: forward a single stop to the engine per live session. The
      // engine still flushes a final result (if any) and fires onend, which
      // tears the session down.
      if (recognition && listening && !stopRequested) {
        stopRequested = true;
        try {
          recognition.stop();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

let singleton: DictationController | null = null;

/** The one live recognition controller for the whole Phil surface. */
export function getDictationController(): DictationController {
  if (!singleton) singleton = createDictationController();
  return singleton;
}

/** Test seam — reset the module-level singleton between specs. */
export function __resetDictationSingleton(): void {
  singleton = null;
}
