import { describe, expect, it } from "vitest";
import {
  sheetHistoryReducer,
  SHEET_HISTORY_INITIAL,
  type SheetHistoryEvent,
  type SheetHistoryState,
} from "./useSheetHistory";

/**
 * The pure back-stack decision for sheet back-safety (#149, slice 1). These
 * cover the load-bearing guarantees with NO DOM and no history object — exactly
 * the test-infra the issue mandates (no jsdom):
 *   - open pushes a sentinel marker;
 *   - a marker-popping popstate closes the sheet (back gesture → close, not nav);
 *   - a programmatic close unwinds the entry via a single guarded back();
 *   - the double-back race (Close tap + immediate swipe) pops exactly once.
 */

/** Drive a sequence of events from the initial state, returning the running
 *  list of effects plus the final state — so a whole gesture reads as one line. */
function run(events: SheetHistoryEvent[], from: SheetHistoryState = SHEET_HISTORY_INITIAL) {
  let state = from;
  const effects = events.map((e) => {
    const r = sheetHistoryReducer(state, e);
    state = r.state;
    return r.effect;
  });
  return { state, effects };
}

describe("sheetHistoryReducer", () => {
  it("starts unmarked", () => {
    expect(SHEET_HISTORY_INITIAL).toEqual({ marked: false });
  });

  it("open pushes the sentinel marker (effect: push), not yet armed", () => {
    const r = sheetHistoryReducer(SHEET_HISTORY_INITIAL, { type: "open" });
    expect(r.effect).toBe("push");
    // The push hasn't been confirmed yet, so we're not armed until `pushed`.
    expect(r.state.marked).toBe(false);
  });

  it("open → pushed arms the marker", () => {
    const { state, effects } = run([{ type: "open" }, { type: "pushed" }]);
    expect(effects).toEqual(["push", "none"]);
    expect(state.marked).toBe(true);
  });

  it("a marker-popping popstate closes the sheet (back gesture → close, not navigate)", () => {
    const { state, effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "popped-marker" },
    ]);
    // The back gesture asks the host to run onClose, NOT to navigate the page.
    expect(effects).toEqual(["push", "none", "onClose"]);
    // The marker is consumed by the pop (single-shot).
    expect(state.marked).toBe(false);
  });

  it("a programmatic close unwinds our own entry via a guarded history.back()", () => {
    const { state, effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "programmatic-close" },
    ]);
    expect(effects).toEqual(["push", "none", "back"]);
    expect(state.marked).toBe(false);
  });

  it("double-back race: Close tap THEN an immediate swipe pops exactly once", () => {
    const { state, effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "programmatic-close" }, // Close button → unwind (back)
      { type: "popped-marker" }, // the swipe's popstate lands AFTER the marker is gone
    ]);
    // Exactly one history action (the back); the trailing pop is a no-op, so no
    // second back() and no orphaned entry.
    expect(effects).toEqual(["push", "none", "back", "none"]);
    expect(state.marked).toBe(false);
  });

  it("reverse double-back race: a swipe THEN a Close tap also pops exactly once", () => {
    const { effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "popped-marker" }, // the swipe closed it (onClose)
      { type: "programmatic-close" }, // a late Close tap finds nothing to unwind
    ]);
    expect(effects).toEqual(["push", "none", "onClose", "none"]);
  });

  it("a popstate that is NOT ours is ignored (someone else's history entry)", () => {
    // Unmarked state — e.g. the marker was already consumed, or we never pushed.
    const r = sheetHistoryReducer({ marked: false }, { type: "popped-marker" });
    expect(r.effect).toBe("none");
    expect(r.state.marked).toBe(false);
  });

  it("a programmatic close with nothing pushed is a no-op (never an orphan back())", () => {
    const r = sheetHistoryReducer({ marked: false }, { type: "programmatic-close" });
    expect(r.effect).toBe("none");
  });

  it("re-open while already armed is idempotent — never stacks a second entry", () => {
    const armed: SheetHistoryState = { marked: true };
    const r = sheetHistoryReducer(armed, { type: "open" });
    expect(r.effect).toBe("none");
    expect(r.state.marked).toBe(true);
  });

  it("close while STILL marked unwinds the orphan entry exactly once", () => {
    // A parent-driven close that bypassed closeWithHistory (e.g. a successful
    // submit that just flips the parent's open state) must unwind the pushed
    // entry, not leave it dangling.
    const armed: SheetHistoryState = { marked: true };
    const r = sheetHistoryReducer(armed, { type: "close" });
    expect(r.effect).toBe("back");
    expect(r.state).toEqual(SHEET_HISTORY_INITIAL);
  });

  it("close after closeWithHistory already cleared the marker is a plain disarm (no double back)", () => {
    const { state, effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "programmatic-close" }, // closeWithHistory: back, marker cleared
      { type: "close" }, // the resulting open=false cleanup: nothing left to undo
    ]);
    expect(effects).toEqual(["push", "none", "back", "none"]);
    expect(state).toEqual(SHEET_HISTORY_INITIAL);
  });

  it("close after a back gesture already popped the marker is a plain disarm", () => {
    const { effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "popped-marker" }, // back gesture: browser popped + onClose
      { type: "close" }, // the resulting open=false cleanup: nothing to undo
    ]);
    expect(effects).toEqual(["push", "none", "onClose", "none"]);
  });

  it("a full open → close → re-open cycle pushes a fresh marker each open", () => {
    const { state, effects } = run([
      { type: "open" },
      { type: "pushed" },
      { type: "close" }, // parent-driven close while marked → unwind (back)
      { type: "open" }, // re-open pushes again
      { type: "pushed" },
    ]);
    expect(effects).toEqual(["push", "none", "back", "push", "none"]);
    expect(state.marked).toBe(true);
  });
});
