import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDictation,
  createDictationController,
  detectDictationMode,
  getDictationController,
  __resetDictationSingleton,
} from "./speechDictation";

/**
 * Pure dictation adapter (#147). No DOM, no React — every test passes an
 * explicit fake `globals`/ctor so it runs in node-env.
 */

/** A minimal fake SpeechRecognition we can drive from the test. */
class FakeRecognition {
  lang = "";
  continuous = true;
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  emitResult(text: string) {
    this.onresult?.({ results: [[{ transcript: text }]] });
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
  emitEnd() {
    this.onend?.();
  }
}

/** Track the most-recently-constructed fake so a test can drive it. */
function makeCtor() {
  const instances: FakeRecognition[] = [];
  const Ctor = vi.fn(function (this: unknown) {
    const r = new FakeRecognition();
    instances.push(r);
    return r;
  }) as unknown as new () => FakeRecognition;
  return { Ctor, instances };
}

afterEach(() => {
  __resetDictationSingleton();
});

describe("detectDictationMode", () => {
  it("returns 'unsupported' with no SpeechRecognition", () => {
    expect(detectDictationMode({ navigator: { userAgent: "anything" } })).toBe("unsupported");
  });

  it("returns 'api' for Android Chrome (webkitSpeechRecognition, not iOS)", () => {
    const { Ctor } = makeCtor();
    expect(
      detectDictationMode({
        webkitSpeechRecognition: Ctor,
        navigator: { userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120" },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe("api");
  });

  it("returns 'api' for a desktop with SpeechRecognition", () => {
    const { Ctor } = makeCtor();
    expect(
      detectDictationMode({
        SpeechRecognition: Ctor,
        navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120" },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe("api");
  });

  it("returns 'keyboard-nudge' on an iOS standalone PWA (navigator.standalone)", () => {
    const { Ctor } = makeCtor();
    expect(
      detectDictationMode({
        webkitSpeechRecognition: Ctor,
        navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari", standalone: true },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe("keyboard-nudge");
  });

  it("returns 'keyboard-nudge' on an iOS standalone PWA (display-mode: standalone)", () => {
    const { Ctor } = makeCtor();
    expect(
      detectDictationMode({
        webkitSpeechRecognition: Ctor,
        navigator: { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari" },
        matchMedia: (q) => ({ matches: q.includes("standalone") }),
      }),
    ).toBe("keyboard-nudge");
  });

  it("returns 'api' for iOS Safari in a normal tab (not standalone)", () => {
    const { Ctor } = makeCtor();
    expect(
      detectDictationMode({
        webkitSpeechRecognition: Ctor,
        navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari", standalone: false },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe("api");
  });
});

describe("appendDictation", () => {
  it("appends to typed text with a single joining space (never clobbers)", () => {
    expect(appendDictation("rough-in done", "checked the riser", 280)).toBe(
      "rough-in done checked the riser",
    );
  });

  it("returns the fragment alone when the field was empty", () => {
    expect(appendDictation("", "first words", 280)).toBe("first words");
  });

  it("does not double-space when existing text already ends in whitespace", () => {
    expect(appendDictation("note ", "more", 280)).toBe("note more");
  });

  it("trims the incoming fragment's edges", () => {
    expect(appendDictation("a", "  b  ", 280)).toBe("a b");
  });

  it("is a no-op (keeps typed text) for a blank fragment", () => {
    expect(appendDictation("typed", "   ", 280)).toBe("typed");
  });

  it("hard-caps the result at max so it can't exceed the field limit", () => {
    // existing(5) + space + fragment → "12345 6789" → capped to 7 chars.
    expect(appendDictation("12345", "6789", 7)).toBe("12345 6");
    expect(appendDictation("12345", "6789", 7).length).toBe(7);
    // A long dictation onto an empty field is capped to exactly max.
    expect(appendDictation("", "a".repeat(50), 10)).toBe("a".repeat(10));
  });
});

describe("createDictationController", () => {
  it("starts a single-shot en-AU final-only session and reports the result", () => {
    const { Ctor, instances } = makeCtor();
    const controller = createDictationController({ webkitSpeechRecognition: Ctor });
    const onResult = vi.fn();
    const ok = controller.start({ onResult, onError: vi.fn(), onEnd: vi.fn() });
    expect(ok).toBe(true);
    expect(controller.isListening()).toBe(true);
    const rec = instances[0]!;
    expect(rec.lang).toBe("en-AU");
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(false);
    expect(rec.started).toBe(1);
    rec.emitResult("  hello site  ");
    expect(onResult).toHaveBeenCalledWith("hello site");
  });

  it("returns false (and stays idle) when SpeechRecognition is unavailable", () => {
    const controller = createDictationController({});
    expect(controller.start({ onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toBe(false);
    expect(controller.isListening()).toBe(false);
  });

  it("reports a permission error and ends without a result", () => {
    const { Ctor, instances } = makeCtor();
    const controller = createDictationController({ webkitSpeechRecognition: Ctor });
    const onError = vi.fn();
    const onEnd = vi.fn();
    const onResult = vi.fn();
    controller.start({ onResult, onError, onEnd });
    const rec = instances[0]!;
    rec.emitError("not-allowed");
    rec.emitEnd();
    expect(onError).toHaveBeenCalledWith("permission");
    expect(onResult).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(controller.isListening()).toBe(false);
  });

  it("classifies a mid-dictation network drop as a 'network' stop", () => {
    const { Ctor, instances } = makeCtor();
    const controller = createDictationController({ webkitSpeechRecognition: Ctor });
    const onError = vi.fn();
    controller.start({ onResult: vi.fn(), onError, onEnd: vi.fn() });
    instances[0]!.emitError("network");
    expect(onError).toHaveBeenCalledWith("network");
  });

  it("singleton guard: a second start aborts the live session and reuses one instance", () => {
    const { Ctor, instances } = makeCtor();
    const controller = createDictationController({ webkitSpeechRecognition: Ctor });
    const firstEnd = vi.fn();
    controller.start({ onResult: vi.fn(), onError: vi.fn(), onEnd: firstEnd });
    expect(controller.isListening()).toBe(true);
    // Second start while the first is live → the live one is aborted, and the
    // SAME recognition object is reused (one instance, ever).
    controller.start({ onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() });
    expect(instances.length).toBe(1);
    expect(instances[0]!.aborted).toBe(1);
    expect(controller.isListening()).toBe(true);
  });

  it("stop() asks the engine to stop the live session (idempotent)", () => {
    const { Ctor, instances } = makeCtor();
    const controller = createDictationController({ webkitSpeechRecognition: Ctor });
    controller.start({ onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() });
    controller.stop();
    controller.stop();
    expect(instances[0]!.stopped).toBe(1);
  });
});

describe("getDictationController", () => {
  it("returns the same module-level singleton across calls", () => {
    const a = getDictationController();
    const b = getDictationController();
    expect(a).toBe(b);
  });
});
