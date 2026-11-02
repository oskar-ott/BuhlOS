/**
 * ITP builder — the client-side photo queue (handoff 2026-11-02, "Uploads").
 *
 * Pending photos live OUTSIDE the refetched report (blob + area + state) and
 * are merged into the render, so a refetch can never drop a tile. Uploads go
 * one at a time in the order taken, but nothing locks the screen.
 *
 * Pure reducer + selectors, unit-tested in node; the builder component is a
 * thin shell that runs the sends and dispatches what actually happened.
 *
 * Tile states (every one has words — colour is never the only signal):
 *   waiting   queued, not sent yet
 *   saving    the request is in flight
 *   failed    the server answered with an error        → "Didn't save", Retry
 *   notSent   the network failed / the phone is offline → "Not sent", Retry all
 *   tooBig    over 8 MB, caught on the phone, never sent → "Over 8 MB · Not added", Clear
 */

export type PendingState = "waiting" | "saving" | "failed" | "notSent" | "tooBig";

export interface PendingPhoto {
  localId: string;
  areaId: string;
  file: File;
  /** Object URL for the tile preview (the component owns revoke). */
  previewUrl: string;
  state: PendingState;
  /** Server message for a failed save, when there was one. */
  message?: string;
}

export interface QueueState {
  items: PendingPhoto[];
  /** The running "Saving 1 of 3" batch: resets once nothing is pending. */
  batch: { total: number; done: number };
}

export const QUEUE_INITIAL: QueueState = { items: [], batch: { total: 0, done: 0 } };

export type QueueEvent =
  | { type: "add"; items: PendingPhoto[] }
  | { type: "start"; localId: string }
  | { type: "saved"; localId: string }
  | { type: "failed"; localId: string; kind: "server" | "network"; message?: string }
  | { type: "retry"; localId: string }
  | { type: "retryAll" }
  | { type: "clear"; localId: string }
  | { type: "dropArea"; areaId: string }
  /** A just-created area got its server id: re-key its pending tiles. */
  | { type: "reassignArea"; from: string; to: string };

const PENDING: ReadonlySet<PendingState> = new Set(["waiting", "saving", "failed", "notSent"]);

function isSendable(s: PendingState): boolean {
  return s === "waiting" || s === "saving";
}

export function queueReducer(state: QueueState, event: QueueEvent): QueueState {
  switch (event.type) {
    case "add": {
      const sendable = event.items.filter((i) => isSendable(i.state)).length;
      const stillGoing = state.items.some((i) => isSendable(i.state));
      const batch = stillGoing
        ? { total: state.batch.total + sendable, done: state.batch.done }
        : { total: sendable, done: 0 };
      return { items: [...state.items, ...event.items], batch };
    }
    case "start":
      return {
        ...state,
        items: state.items.map((i) =>
          i.localId === event.localId ? { ...i, state: "saving" } : i
        ),
      };
    case "saved": {
      const items = state.items.filter((i) => i.localId !== event.localId);
      const done = state.batch.done + 1;
      const anyLeft = items.some((i) => isSendable(i.state));
      return { items, batch: anyLeft ? { total: state.batch.total, done } : { total: 0, done: 0 } };
    }
    case "failed": {
      const items = state.items.map((i) =>
        i.localId === event.localId
          ? {
              ...i,
              state: event.kind === "network" ? ("notSent" as const) : ("failed" as const),
              message: event.message,
            }
          : i
      );
      const anyLeft = items.some((i) => isSendable(i.state));
      return { items, batch: anyLeft ? state.batch : { total: 0, done: 0 } };
    }
    case "retry": {
      const items = state.items.map((i) =>
        i.localId === event.localId && (i.state === "failed" || i.state === "notSent")
          ? { ...i, state: "waiting" as const, message: undefined }
          : i
      );
      return { items, batch: restartBatch(state, items) };
    }
    case "retryAll": {
      const items = state.items.map((i) =>
        i.state === "failed" || i.state === "notSent"
          ? { ...i, state: "waiting" as const, message: undefined }
          : i
      );
      return { items, batch: restartBatch(state, items) };
    }
    case "clear":
      return { ...state, items: state.items.filter((i) => i.localId !== event.localId) };
    case "dropArea":
      return { ...state, items: state.items.filter((i) => i.areaId !== event.areaId) };
    case "reassignArea":
      return {
        ...state,
        items: state.items.map((i) => (i.areaId === event.from ? { ...i, areaId: event.to } : i)),
      };
    default:
      return state;
  }
}

function restartBatch(prev: QueueState, items: PendingPhoto[]): QueueState["batch"] {
  const before = prev.items.filter((i) => isSendable(i.state)).length;
  const after = items.filter((i) => isSendable(i.state)).length;
  if (!after) return { total: 0, done: 0 };
  // Still going → the re-queued ones join the running batch; else a new one.
  if (before > 0) return { total: prev.batch.total + (after - before), done: prev.batch.done };
  return { total: after, done: 0 };
}

/** The next photo to send — the first waiting one, in the order taken — or
 *  null when one is already in flight or nothing waits. */
export function nextToSend(state: QueueState): PendingPhoto | null {
  if (state.items.some((i) => i.state === "saving")) return null;
  return state.items.find((i) => i.state === "waiting") ?? null;
}

export interface QueueSummary {
  waiting: number;
  saving: number;
  failed: number;
  notSent: number;
  tooBig: number;
  /** "Saving 1 of 3" — null when nothing is saving. */
  savingLabel: string | null;
  /** Any tile the worker would lose by leaving. */
  unsaved: number;
}

export function summarise(state: QueueState): QueueSummary {
  let waiting = 0;
  let saving = 0;
  let failed = 0;
  let notSent = 0;
  let tooBig = 0;
  for (const i of state.items) {
    if (i.state === "waiting") waiting += 1;
    else if (i.state === "saving") saving += 1;
    else if (i.state === "failed") failed += 1;
    else if (i.state === "notSent") notSent += 1;
    else if (i.state === "tooBig") tooBig += 1;
  }
  const savingLabel =
    saving + waiting > 0 && state.batch.total > 0
      ? `Saving ${Math.min(state.batch.done + 1, state.batch.total)} of ${state.batch.total}`
      : null;
  return {
    waiting,
    saving,
    failed,
    notSent,
    tooBig,
    savingLabel,
    unsaved: state.items.filter((i) => PENDING.has(i.state)).length,
  };
}

/** Tile words for each state — exactly the handoff's strings. */
export const TILE_LABEL: Record<PendingState, string> = {
  waiting: "Waiting",
  saving: "Saving",
  failed: "Didn't save",
  notSent: "Not sent",
  tooBig: "Over 8 MB · Not added",
};
