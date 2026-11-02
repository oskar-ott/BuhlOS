import { describe, expect, it } from "vitest";
import {
  QUEUE_INITIAL,
  nextToSend,
  queueReducer,
  summarise,
  type PendingPhoto,
  type QueueState,
} from "./upload-queue";

/**
 * The ITP photo queue reducer (handoff 2026-11-02 "Uploads"). Pins: one at a
 * time in the order taken, the "Saving 1 of 3" count, network → Not sent vs
 * server → Didn't save, Retry / Retry all re-queue in order, Clear drops a
 * too-big tile, and the leave-guard count.
 */

function item(
  localId: string,
  state: PendingPhoto["state"] = "waiting",
  areaId = "a1"
): PendingPhoto {
  return { localId, areaId, file: {} as File, previewUrl: `blob:${localId}`, state };
}

function run(
  events: Parameters<typeof queueReducer>[1][],
  from: QueueState = QUEUE_INITIAL
): QueueState {
  return events.reduce(queueReducer, from);
}

describe("itp upload queue", () => {
  it("sends one at a time in the order taken", () => {
    const s = run([{ type: "add", items: [item("1"), item("2"), item("3")] }]);
    expect(nextToSend(s)?.localId).toBe("1");
    const s2 = queueReducer(s, { type: "start", localId: "1" });
    expect(nextToSend(s2)).toBeNull();
    const s3 = queueReducer(s2, { type: "saved", localId: "1" });
    expect(nextToSend(s3)?.localId).toBe("2");
    expect(s3.items.map((i) => i.localId)).toEqual(["2", "3"]);
  });

  it("counts 'Saving n of total' across the batch and resets when done", () => {
    let s = run([{ type: "add", items: [item("1"), item("2"), item("3")] }]);
    expect(summarise(s).savingLabel).toBe("Saving 1 of 3");
    s = run(
      [
        { type: "start", localId: "1" },
        { type: "saved", localId: "1" },
      ],
      s
    );
    expect(summarise(s).savingLabel).toBe("Saving 2 of 3");
    // More picked while still going joins the same batch.
    s = queueReducer(s, { type: "add", items: [item("4")] });
    expect(summarise(s).savingLabel).toBe("Saving 2 of 4");
    s = run(
      [
        { type: "start", localId: "2" },
        { type: "saved", localId: "2" },
        { type: "start", localId: "3" },
        { type: "saved", localId: "3" },
        { type: "start", localId: "4" },
        { type: "saved", localId: "4" },
      ],
      s
    );
    expect(s.items).toEqual([]);
    expect(summarise(s).savingLabel).toBeNull();
    expect(s.batch).toEqual({ total: 0, done: 0 });
  });

  it("tells a network failure (Not sent) from a server error (Didn't save)", () => {
    const s = run([
      { type: "add", items: [item("1"), item("2")] },
      { type: "start", localId: "1" },
      { type: "failed", localId: "1", kind: "network" },
      { type: "start", localId: "2" },
      { type: "failed", localId: "2", kind: "server", message: "photo too large" },
    ]);
    expect(s.items.map((i) => i.state)).toEqual(["notSent", "failed"]);
    expect(s.items[1]!.message).toBe("photo too large");
    const sum = summarise(s);
    expect(sum.notSent).toBe(1);
    expect(sum.failed).toBe(1);
    expect(sum.savingLabel).toBeNull();
    expect(sum.unsaved).toBe(2);
  });

  it("Retry re-queues one; Retry all re-queues every failed/not-sent in order", () => {
    const base = run([
      { type: "add", items: [item("1"), item("2"), item("3")] },
      { type: "start", localId: "1" },
      { type: "failed", localId: "1", kind: "server" },
      { type: "start", localId: "2" },
      { type: "failed", localId: "2", kind: "network" },
      { type: "start", localId: "3" },
      { type: "saved", localId: "3" },
    ]);
    const one = queueReducer(base, { type: "retry", localId: "2" });
    expect(one.items.map((i) => i.state)).toEqual(["failed", "waiting"]);
    expect(nextToSend(one)?.localId).toBe("2");
    expect(summarise(one).savingLabel).toBe("Saving 1 of 1");

    const all = queueReducer(base, { type: "retryAll" });
    expect(all.items.map((i) => i.state)).toEqual(["waiting", "waiting"]);
    expect(nextToSend(all)?.localId).toBe("1");
    expect(summarise(all).savingLabel).toBe("Saving 1 of 2");
  });

  it("a too-big photo is never sent and Clear removes it", () => {
    const s = run([{ type: "add", items: [item("big", "tooBig"), item("ok")] }]);
    expect(nextToSend(s)?.localId).toBe("ok");
    expect(summarise(s).tooBig).toBe(1);
    expect(summarise(s).unsaved).toBe(1); // the too-big one isn't "lost" — it's in the camera roll
    const cleared = queueReducer(s, { type: "clear", localId: "big" });
    expect(cleared.items.map((i) => i.localId)).toEqual(["ok"]);
  });

  it("removing an area drops its pending tiles", () => {
    const s = run([
      { type: "add", items: [item("1", "waiting", "a1"), item("2", "waiting", "a2")] },
    ]);
    expect(queueReducer(s, { type: "dropArea", areaId: "a1" }).items.map((i) => i.localId)).toEqual(
      ["2"]
    );
  });
});
