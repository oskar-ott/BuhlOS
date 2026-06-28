import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  DictateButtonView,
  PhilDictateButton,
  type DictateLiveState,
} from "./PhilDictateButton";
import type { DictationMode } from "../speechDictation";

/**
 * Dictation mic (#147). The visual states live in the pure `DictateButtonView`
 * (props in → markup out), so every branch is reachable under the repo's
 * node-env SSR render. The stateful `PhilDictateButton` is also smoke-rendered
 * to lock its SSR default: effects don't run under renderToString, so it must
 * paint NOTHING (the honest "unsupported until proven otherwise" default — no
 * hydration flash of a control that may not work).
 */

function view(mode: DictationMode, state: DictateLiveState, extra?: { online?: boolean }) {
  return renderToString(
    createElement(DictateButtonView, {
      mode,
      state,
      online: extra?.online ?? true,
      disabled: false,
      onToggle: () => {},
      onNudge: () => {},
    }),
  );
}

describe("DictateButtonView", () => {
  it("renders nothing when speech is unsupported (typed input untouched)", () => {
    expect(view("unsupported", { kind: "idle" })).toBe("");
  });

  it("idle api mode shows the Dictate label, not pressed/busy, ≥48px target", () => {
    const html = view("api", { kind: "idle" });
    expect(html).toContain("Dictate");
    expect(html).toContain("h-12"); // ≥48px gloved tap target
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-busy="false"');
    // Honest privacy copy — built-in phone speech + text-only; NOT "no audio".
    expect(html).toContain("built-in speech");
    expect(html).toContain("only gets the text");
    expect(html.toLowerCase()).not.toContain("no audio");
  });

  it("listening state is aria-pressed + aria-busy with a stop affordance", () => {
    const html = view("api", { kind: "listening" });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Listening");
    expect(html).toContain("tap to stop");
    // state-* token treatment: the listening colour is carried by the solid
    // state-danger rail + icon, NOT an opacity tint. The only opacity utility
    // allowed is the standard disabled affordance (disabled:opacity-60).
    expect(html).toContain("state-danger");
    expect(html.replace(/disabled:opacity-60/g, "")).not.toContain("opacity-");
  });

  it("permission-denied shows a one-time hint (no live mic button)", () => {
    const html = view("api", { kind: "denied" });
    expect(html).toContain("Mic is blocked");
    expect(html).toContain("typing still works");
    // The mic toggle is gone — denial doesn't re-prompt.
    expect(html).not.toContain('aria-pressed');
  });

  it("a stopped state (e.g. signal loss) keeps typed input safe in the copy", () => {
    const html = view("api", {
      kind: "stopped",
      message: "Lost signal — dictation stopped. Your typed note is safe.",
    });
    expect(html).toContain("dictation stopped");
    expect(html).toContain("typed note is safe");
  });

  it("offline disables the mic and says dictation needs a connection", () => {
    const html = view("api", { kind: "idle" }, { online: false });
    expect(html).toContain("needs a connection");
    expect(html).toContain("disabled");
  });

  it("iOS keyboard-nudge points at the keyboard mic key with honest copy", () => {
    const html = view("keyboard-nudge", { kind: "idle" });
    expect(html).toContain("Dictate");
    expect(html).toContain("microphone key on your keyboard");
    expect(html).toContain("only ever gets the text");
    expect(html.toLowerCase()).not.toContain("no audio");
  });
});

describe("PhilDictateButton (SSR default)", () => {
  it("renders nothing on the server (mode resolves only after mount)", () => {
    const html = renderToString(
      createElement(PhilDictateButton, {
        value: "",
        onAppend: () => {},
        max: 280,
      }),
    );
    expect(html).toBe("");
  });
});
